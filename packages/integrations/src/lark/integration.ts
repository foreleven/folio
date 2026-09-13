import { Effect, FileSystem, Schedule } from 'effect'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { ChildProcessSpawner } from 'effect/unstable/process'
import { defineIntegration, IntegrationContext, IntegrationError } from '../base/index.ts'
import type { CheckResult, IngestContext, IntegrationAction } from '../base/index.ts'
import { LarkAuth } from './auth.ts'
import type { LarkAuthSnapshot } from './auth.ts'
import { ensureCli, findCli, LARK_USER_ACCESS_TOKEN_ENV } from './cli.ts'
import { larkMetadata } from './metadata.ts'
import { hasSkills, installSkills, skillNames } from './skills.ts'
import { migratePrivateState, readPrivateState, updatePrivateState } from './state.ts'
import { ensureExtractor } from './workflows.ts'

const imWorkflowPrompt = 'For the current Routine window, read raws/lark-im/_workflow.md and run the extraction workflow it describes before reviewing messages. Use the execution window provided by the Routine; do not invent a different time range.'
const imWorkflowFile = [
  '# Lark IM window workflow', '', imWorkflowPrompt, '',
  'Run `node raws/lark-im/extract-window.mjs --start <ISO> --end <ISO> --output raws/lark-im`.',
  'The script excludes muted chats, reads the 100 most active conversations, writes one raw file per changed chat, and updates `raws/lark-im/_updated.md`.', ''
].join('\n')

/** Mounts the selected capability and shared rules; the Agent decides which CLI commands to execute. */
const onIngest = (skill: 'lark-im' | 'lark-mail') => (context: IngestContext) => Effect.gen(function* () {
  for (const name of ['lark-shared', skill]) {
    const entrypoint = join(context.integrationDirectory, 'skills', name, 'SKILL.md')
    if (!context.skills.includes(entrypoint)) context.skills.push(entrypoint)
  }
  const cli = join(context.integrationDirectory, 'cli')
  if (!context.executableDirectories.includes(cli)) context.executableDirectories.push(cli)
  if (skill === 'lark-im') {
    if (!context.instructions.includes(imWorkflowPrompt)) context.instructions.push(imWorkflowPrompt)
    if (context.workspaceFiles) {
      // Keep the extractor outside the existing Skill contract. It is copied into
      // the isolated Task workspace so the Agent can run it without depending on
      // an installation-specific resource path.
      const script = yield* Effect.tryPromise({
        try: () => readFile(join(context.integrationDirectory, 'workflows', 'lark-im', 'extract-window.mjs'), 'utf8'),
        catch: () => new IntegrationError({ message: 'The Lark IM extraction workflow is not installed.' })
      })
      context.workspaceFiles.push(
        { path: 'raws/lark-im/_workflow.md', content: imWorkflowFile },
        { path: 'raws/lark-im/extract-window.mjs', content: script }
      )
    }
  }
  // The CLI is launched by the Agent, so pass only the short-lived user token
  // through the ephemeral Task environment; it is never copied into snapshots.
  const token = yield* Effect.tryPromise({
    try: async () => {
      let raw: string
      try { raw = await readFile(join(context.integrationDirectory, 'private.json'), 'utf8') }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          // A legacy installation may be prepared before its background setup
          // gets a chance to consolidate auth.json into private.json.
          try { raw = await readFile(join(context.integrationDirectory, 'auth.json'), 'utf8') }
          catch (legacyError) {
            if (legacyError instanceof Error && 'code' in legacyError && legacyError.code === 'ENOENT') return undefined
            throw legacyError
          }
          const legacy = JSON.parse(raw) as { accessToken?: unknown }
          return typeof legacy.accessToken === 'string' ? legacy.accessToken : undefined
        }
        throw error
      }
      const parsed = JSON.parse(raw) as { userAuth?: { accessToken?: unknown } }
      return typeof parsed.userAuth?.accessToken === 'string' ? parsed.userAuth.accessToken : undefined
    },
    catch: () => new IntegrationError({ message: 'Lark user authorization is unavailable.' })
  })
  if (token) context.env[LARK_USER_ACCESS_TOKEN_ENV] = token
})
const resources = [
  { id: 'im', type: 'im' as const, name: { en: 'Messages', 'zh-CN': '即时通讯' }, onIngest: onIngest('lark-im') },
  { id: 'email', type: 'email' as const, name: { en: 'Email', 'zh-CN': '邮箱' }, onIngest: onIngest('lark-mail') }
] as const
const actions = [
  { id: 'open_authorization', label: { en: 'Continue in browser', 'zh-CN': '前往授权' } },
  { id: 'install', label: { en: 'Install', 'zh-CN': '安装' } },
  {
    id: 'connect',
    label: { en: 'Connect Lark', 'zh-CN': '连接飞书' },
    description: { en: 'Continue from your saved connection progress.', 'zh-CN': '从已保存的进度继续连接。' }
  }
] as const

/** Lark owns authorization-domain policy; the host only supports generic HTTPS navigation. */
const authorizationActions = Effect.fn('LarkIntegration.authorizationActions')(function* (
  url?: string
): Effect.fn.Return<readonly IntegrationAction[], IntegrationError> {
  if (!url) return []
  const parsed = yield* Effect.try({
    try: () => new URL(url),
    catch: () => new IntegrationError({ message: 'Invalid Lark authorization URL.' })
  })
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    ![
      'open.feishu.cn',
      'accounts.feishu.cn',
      'open.larkoffice.com',
      'accounts.larksuite.com',
      'open.larksuite.com'
    ].includes(parsed.hostname)
  )
    return yield* new IntegrationError({ message: 'Invalid Lark authorization URL.' })
  return [{ id: 'open_authorization', type: 'open-url', url: parsed.toString(), primary: true }]
})

function result(state: string, action?: 'install' | 'connect'): CheckResult {
  return { state, actions: action ? [{ id: action, type: 'callback', primary: true }] : [] }
}

/** Maps auth-domain phases to the stable, provider-agnostic Integration state protocol. */
function integrationState(phase: LarkAuthSnapshot['phase']): CheckResult {
  switch (phase) {
    case 'app_missing':
      return result('app_required', 'connect')
    case 'app_rejected':
      return result('app_authorization_required', 'connect')
    case 'app_recovering':
      return result('recovering')
    case 'user_missing':
    case 'user_rejected':
      return result('login_required', 'connect')
    case 'user_recovering':
      return result('recovering')
    case 'ready':
      return result('ready')
  }
}

/** Creates the private integration directory without creating a vault workspace. */
const prepareDirectory = Effect.fn('LarkIntegration.prepareDirectory')(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
  yield* fs.chmod(directory, 0o700)
})

/** Thin adapter from Lark domain services to the generic Integration protocol. */
const make = Effect.fn('LarkIntegration.make')(function* () {
  const auth = yield* LarkAuth

  const check = Effect.fn('LarkIntegration.check')(
    function* () {
      yield* auth.check()
    },
    Effect.annotateLogs({ integration: 'lark', subsystem: 'integration' }),
    Effect.withLogSpan('lark.integration.check')
  )

  /** Read-only inspection maps durable auth facts into UI state and never triggers remote work. */
  const inspect = Effect.fn('LarkIntegration.inspect')(function* (): Effect.fn.Return<
    CheckResult,
    unknown,
    IntegrationContext | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
  > {
    const { directory } = yield* IntegrationContext
    const privateState = yield* readPrivateState(directory)
    if (!(yield* findCli(directory)) || !(yield* hasSkills(directory)) || !privateState.installed) {
      return result('install_required', 'install')
    }
    return integrationState((yield* auth.inspect()).phase)
  })

  const install = Effect.fn('LarkIntegration.install')(
    function* () {
      const context = yield* IntegrationContext
      yield* Effect.logInfo('Lark installation started')
      yield* auth.exclusive(
        Effect.gen(function* () {
          yield* context.writeState('installing', {})
          yield* prepareDirectory(context.directory)
          yield* ensureCli(context.directory)
          yield* Effect.logInfo('Lark CLI ready')
          yield* installSkills(context.directory)
          yield* Effect.logInfo('Lark skills ready').pipe(Effect.annotateLogs({ skillCount: skillNames.length }))
          yield* ensureExtractor(context.directory)
          yield* Effect.logInfo('Lark workflows ready')
          for (const resource of resources) yield* context.registerResource(resource)
          yield* updatePrivateState(context.directory, { installed: true })
        })
      )
      yield* auth.recover
      yield* Effect.logInfo('Lark installation completed')
    },
    Effect.tapError(() => Effect.logError('Lark installation failed')),
    Effect.annotateLogs({ integration: 'lark', subsystem: 'integration' }),
    Effect.withLogSpan('lark.integration.install')
  )

  const connect = Effect.fn('LarkIntegration.connect')(
    function* () {
      const context = yield* IntegrationContext
      yield* Effect.logInfo('Lark connection started')
      yield* prepareDirectory(context.directory)
      yield* auth.connect({
        onAppProgress: Effect.fn('LarkIntegration.appProgress')(function* (data) {
          yield* context.writeState('waiting_for_app', {}, yield* authorizationActions(data.url))
        }),
        onAppReady: () => context.writeState('verifying_app', {}),
        onUserRequired: () => context.writeState('authorizing', {}),
        onUserAuthorize: Effect.fn('LarkIntegration.userProgress')(function* ({ url }) {
          yield* context.writeState('waiting_for_user', {}, yield* authorizationActions(url))
        })
      })
      yield* Effect.logInfo('Lark connection completed')
    },
    Effect.tapError(() => Effect.logError('Lark connection failed')),
    Effect.annotateLogs({ integration: 'lark', subsystem: 'integration' }),
    Effect.withLogSpan('lark.integration.connect')
  )

  /** Performs one maintenance pass; scheduling remains separate from the work and its tracing span. */
  const maintain = Effect.fn('LarkIntegration.maintain')(
    function* () {
      const context = yield* IntegrationContext
      const privateState = yield* readPrivateState(context.directory)
      if (!privateState.installed) return
      const snapshot = yield* auth.reconcile
      const checked = integrationState(snapshot.phase)
      yield* context.writeState(checked.state, {}, checked.actions)
    },
    Effect.catch(() => Effect.flatMap(IntegrationContext, (context) => context.writeState('check_failed', {}))),
    Effect.catch(() => Effect.void),
    Effect.annotateLogs({ integration: 'lark', subsystem: 'integration' })
  )

  /** Performs one-time initialization before scheduled maintenance starts. */
  const initialize = Effect.fn('LarkIntegration.initialize')(
    function* () {
      const context = yield* IntegrationContext
      const { directory } = context
      yield* auth.exclusive(migratePrivateState(directory))
      // A row is created before the explicit install job starts, so setup may
      // be launched for an installation that is still only a catalog entry.
      // Do not publish resources (or create dependent default Routines) until
      // the provider's private installation marker is durable. Existing
      // installed rows still get the static catalog re-registered here, which
      // upgrades legacy resource records with their shared type metadata.
      if (!(yield* readPrivateState(directory)).installed) return
      yield* ensureExtractor(directory)
      // Re-register the static capability catalog on every provider startup. This
      // upgrades installations created before resource `type` was persisted while
      // keeping the operation idempotent for current installations.
      for (const resource of resources) yield* context.registerResource(resource)
    },
    Effect.annotateLogs({ integration: 'lark', subsystem: 'integration' })
  )

  /** Starts scheduled maintenance and stays alive until interrupted by the host. */
  const setup = Effect.fn('LarkIntegration.setup')(
    function* () {
      yield* initialize()
      const maintenanceSchedule = Schedule.forever.pipe(
        Schedule.addDelay(() => auth.nextMaintenance().pipe(Effect.catch(() => Effect.succeed(30_000))))
      )
      yield* maintain().pipe(Effect.repeat(maintenanceSchedule))
    },
    Effect.ensuring(auth.release()),
    Effect.annotateLogs({ integration: 'lark', subsystem: 'integration' }),
  )

  return defineIntegration({
    ...larkMetadata,
    actions,
    resources,
    install,
    check,
    inspect,
    setup,
    onActionCallback: (actionId) => (actionId === 'install' ? install() : connect())
  })
})

export const LarkIntegration = Effect.runSync(make().pipe(Effect.provide(LarkAuth.layer)))
