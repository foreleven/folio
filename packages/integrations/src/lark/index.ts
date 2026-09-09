import { Clock, Effect, FileSystem, Schema } from 'effect'
import { ChildProcessSpawner } from 'effect/unstable/process'
import { join } from 'node:path'
import { defineIntegration, IntegrationContext, IntegrationError } from '../base/index.ts'
import type { CheckResult, IngestContext, IntegrationAction } from '../base/index.ts'
import { authorizeUser } from './auth.ts'
import { larkMetadata } from './metadata.ts'
import { createApp } from './app-registration.ts'
import { ensureCli, findCli } from './cli.ts'
import { hasSkills, installSkills, skillNames } from './skills.ts'
import { AppAuth, readState, UserAuth, writeState } from './state.ts'
import { belongsToApp, getApp, hasPermissions, nextMaintenance, recover, releaseSession, session } from './connection.ts'

/** Agent context enrichment remains outside the connection/settings lifecycle. */
const onIngest = (_context: IngestContext) => Effect.void
const resources = [
  { id: 'im', name: { en: 'Messages', 'zh-CN': '即时通讯' }, onIngest },
  { id: 'email', name: { en: 'Email', 'zh-CN': '邮箱' }, onIngest }
] as const
const actions = [
  { id: 'open_authorization', label: { en: 'Continue in browser', 'zh-CN': '前往授权' } },
  { id: 'install', label: { en: 'Complete installation', 'zh-CN': '完成安装' } },
  { id: 'connect', label: { en: 'Connect Lark', 'zh-CN': '连接飞书' },
    description: { en: 'Continue from your saved connection progress.', 'zh-CN': '从已保存的进度继续连接。' } }
] as const

/** Lark owns authorization-domain policy; the host only supports generic HTTPS navigation. */
const authorizationActions = Effect.fn('Lark.authorizationActions')(function*(url?: string): Effect.fn.Return<readonly IntegrationAction[], IntegrationError> {
  if (!url) return []
  const parsed = yield* Effect.try({ try: () => new URL(url), catch: () => new IntegrationError({ message: 'Invalid Lark authorization URL.' }) })
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || ![
    'open.feishu.cn', 'accounts.feishu.cn', 'open.larkoffice.com', 'accounts.larksuite.com', 'open.larksuite.com'
  ].includes(parsed.hostname)) return yield* new IntegrationError({ message: 'Invalid Lark authorization URL.' })
  return [{ id: 'open_authorization', type: 'open-url', url: parsed.toString(), primary: true }]
})

/** Names the single next user operation without exposing token verification or renewal controls. */
function result(state: string, action?: 'install' | 'connect'): CheckResult {
  return { state, actions: action ? [{ id: action, type: 'callback', primary: true }] : [] }
}

/** Reads durable facts only. Expiry recovery belongs to the provider runtime, not host inspection. */
const inspect = Effect.fn('Lark.inspect')(function*(): Effect.fn.Return<CheckResult, unknown, IntegrationContext | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> {
  const { directory } = yield* IntegrationContext
  if (!(yield* findCli(directory)) || !(yield* hasSkills(directory)) ||
      !(yield* readState(join(directory, 'installed.json'), Schema.Boolean))) return result('install_required', 'install')
  const app = yield* getApp()
  if (!app) return result('app_required', 'connect')
  const current = yield* session()
  const appAuth = yield* readState(join(directory, 'app-auth.json'), AppAuth)
  const saved = yield* readState(join(directory, 'auth.json'), UserAuth)
  const now = yield* Clock.currentTimeMillis
  if (current.rejected === 'app') return result('app_authorization_required', 'connect')
  if (!appAuth || !belongsToApp(appAuth, app) || appAuth.expiresAt <= now) return result('recovering')
  if (!saved || !belongsToApp(saved, app) || !hasPermissions(saved)) return result('login_required', 'connect')
  // A failed proactive refresh does not invalidate a still-valid, previously verified access token.
  if (saved.expiresAt > now && saved.verified !== false) return result('ready')
  if (current.rejected === 'user') return result('login_required', 'connect')
  if (saved.expiresAt <= now && (!saved.refreshToken || (saved.refreshExpiresAt && saved.refreshExpiresAt <= now))) {
    return result('login_required', 'connect')
  }
  return result('recovering')
}, Effect.tap((checked) => Effect.logDebug('Lark inspection completed').pipe(
  Effect.annotateLogs({ state: checked.state, actionCount: checked.actions.length })
)), Effect.annotateLogs({ integration: 'lark', subsystem: 'inspection' }), Effect.withLogSpan('lark.inspect'))

/** Creates the private integration directory without creating a vault workspace. */
const prepareDirectory = Effect.fn('Lark.prepareDirectory')(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
  yield* fs.chmod(directory, 0o700)
  yield* Effect.logDebug('Lark private directory is ready')
})

/** Installs managed dependencies and upserts resources; only existing credentials are verified automatically. */
const install = Effect.fn('Lark.install')(function*() {
  const context = yield* IntegrationContext
  const current = yield* session()
  yield* Effect.gen(function*() {
    yield* Effect.logInfo('Lark installation started')
    yield* context.writeState('installing', {})
    yield* prepareDirectory(context.directory)
    yield* ensureCli(context.directory)
    yield* Effect.logInfo('Lark CLI ready')
    yield* installSkills(context.directory)
    yield* Effect.logInfo('Lark skills ready').pipe(Effect.annotateLogs({ skillCount: skillNames.length }))
    for (const resource of resources) {
      yield* context.registerResource(resource)
      yield* Effect.logDebug('Lark resource registered').pipe(Effect.annotateLogs({ resource: resource.id }))
    }
    yield* writeState(join(context.directory, 'installed.json'), true)
    yield* recover
    yield* Effect.logInfo('Lark installation completed')
  }).pipe(current.lock.withPermit)
}, Effect.tapError(() => Effect.logError('Lark installation failed')), Effect.annotateLogs({ integration: 'lark', subsystem: 'installation' }), Effect.withLogSpan('lark.install'))

/** Resumes connection from durable progress. Browser approval is the only normal user intervention. */
const connect = Effect.fn('Lark.connect')(function*() {
  const context = yield* IntegrationContext
  const current = yield* session()
  yield* Effect.gen(function*() {
    yield* Effect.logInfo('Lark connection started')
    current.rejected = undefined
    yield* prepareDirectory(context.directory)
    let app = yield* getApp()
    if (!app) {
      yield* Effect.logInfo('Lark application registration started')
      yield* context.writeState('creating_app', {})
      app = yield* createApp(Effect.fn('Lark.appProgress')(function*(data) {
        yield* Effect.logDebug('Lark application registration progressed').pipe(
          Effect.annotateLogs({ registrationStatus: data.status })
        )
        yield* context.writeState('waiting_for_app', {}, yield* authorizationActions(data.url))
      }, Effect.annotateLogs({ integration: 'lark', subsystem: 'app-registration' })))
      yield* Effect.logInfo('Lark application registration completed').pipe(Effect.annotateLogs({ brand: app.brand }))
    } else {
      yield* Effect.logDebug('Reusing saved Lark application').pipe(Effect.annotateLogs({ brand: app.brand }))
    }
    // Commit registered/supplied credentials before any exchange so retries never create another app.
    yield* writeState(join(context.directory, 'app.json'), app)
    yield* context.writeState('verifying_app', {})
    yield* recover
    const checked = yield* inspect()
    if (checked.state === 'ready') {
      yield* Effect.logInfo('Lark connection completed').pipe(Effect.annotateLogs({ authorization: 'existing' }))
      return
    }
    if (checked.state !== 'login_required') {
      return yield* new IntegrationError({ message: 'Lark is unable to connect. Please try again.' })
    }
    yield* context.writeState('authorizing', {})
    yield* Effect.logInfo('Lark user authorization started')
    const auth = yield* authorizeUser(app, Effect.fn('Lark.userProgress')(function*({ url }) {
      yield* Effect.logInfo('Waiting for Lark user authorization')
      yield* context.writeState('waiting_for_user', {}, yield* authorizationActions(url))
    }, Effect.annotateLogs({ integration: 'lark', subsystem: 'user-authorization' })))
    yield* Effect.logInfo('Lark user authorization completed')
    yield* writeState(join(context.directory, 'auth.json'), auth)
    current.rejected = undefined
    current.failures = 0
    yield* Effect.logInfo('Lark connection completed').pipe(Effect.annotateLogs({ authorization: 'new' }))
  }).pipe(current.lock.withPermit)
}, Effect.tapError(() => Effect.logError('Lark connection failed')), Effect.annotateLogs({ integration: 'lark', subsystem: 'connection' }), Effect.withLogSpan('lark.connect'))

/** Serializes background writes with setup/OAuth; inspection remains nonblocking during browser approval. */
const run = Effect.fn('Lark.run')(function*() {
  const context = yield* IntegrationContext
  const current = yield* session()
  yield* Effect.logInfo('Lark maintenance runtime started')
  while (true) {
    yield* Effect.logDebug('Lark maintenance check started')
    yield* Effect.gen(function*() {
      // Merely loading the catalog must not install tools, create an app or initiate OAuth.
      if (!(yield* readState(join(context.directory, 'installed.json'), Schema.Boolean))) return
      yield* recover
      const checked = yield* inspect()
      yield* context.writeState(checked.state, {}, checked.actions)
    }).pipe(
      // Failure publication belongs to the same critical section as successful progress.
      Effect.catch(() => Effect.logWarning('Lark maintenance check failed').pipe(
        Effect.andThen(context.writeState('check_failed', {}))
      )), Effect.catch(() => Effect.void), current.lock.withPermit
    )
    const delay = yield* nextMaintenance().pipe(Effect.catch(() => Effect.succeed(30_000)))
    yield* Effect.logDebug('Lark maintenance check scheduled').pipe(Effect.annotateLogs({ delayMs: delay }))
    yield* Effect.sleep(delay)
  }
}, Effect.ensuring(Effect.logInfo('Lark maintenance runtime stopped').pipe(Effect.andThen(releaseSession))),
Effect.annotateLogs({ integration: 'lark', subsystem: 'maintenance' }), Effect.withLogSpan('lark.run'))

export const lark = defineIntegration({
  ...larkMetadata, actions, resources, install, inspect, run,
  onActionCallback: (actionId) => actionId === 'install' ? install() : connect()
})
export { LarkApplication } from './connection.ts'
export type { LarkApp } from './state.ts'
export { LarkCliArchive } from './cli.ts'
export { LarkSkillsDirectory } from './skills.ts'
