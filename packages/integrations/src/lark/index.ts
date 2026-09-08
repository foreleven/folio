import { Clock, Effect, Exit, FileSystem, Schema, Semaphore } from 'effect'
import { join, resolve } from 'node:path'
import { IntegrationError, readyState } from '../integration.ts'
import type { CheckResult, IngestContext, Integration, IntegrationContext } from '../integration.ts'
import { authorizeApp, authorizeUser, larkScopes, refreshUser, userIdentity } from './auth.ts'
import { createApp } from './app-registration.ts'
import { ensureCli, findCli } from './cli.ts'
import { hasSkills, installSkills } from './skills.ts'
import { AppAuth, LarkApp, readState, UserAuth, writeState } from './state.ts'

export interface LarkContext extends IntegrationContext {
  /** Optional application provided by the host instead of registering a new one. */
  readonly app?: LarkApp
}

/** Agent context enrichment is deliberately left unimplemented for both resources. */
const onIngest = (_context: IngestContext) => Effect.void
const resources = [
  { id: 'im', name: '即时通讯', description: 'Lark 会话与消息', onIngest },
  { id: 'email', name: '邮箱', description: 'Lark 邮箱与邮件', onIngest }
] as const
const actions = [
  { id: 'install', label: '安装 CLI 和 skills', description: '复用系统 CLI，安装缺失依赖并注册 IM 和 Email。' },
  { id: 'create_app', label: '创建 Lark 应用', description: '打开授权链接，完成应用注册。' },
  { id: 'verify_app', label: '验证应用授权', description: '验证应用凭据并获取或更新应用 token。' },
  { id: 'refresh_auth', label: '刷新用户授权', description: '使用 refresh token 更新用户授权。' },
  { id: 'authorize', label: '授权访问 Lark', description: '授权读取 IM 和 Email 数据。' }
] as const
const active = new Map<string, { token: symbol; result: CheckResult }>()
const lock = Semaphore.makeUnsafe(1)

/** Normalizes operational failures without exposing credentials in Effect errors. */
const sanitize = (cause: unknown) => cause instanceof IntegrationError ? cause
  : new IntegrationError({ message: 'Could not complete the Lark operation. Check files and connectivity.' })

/** Resolves a supplied or persisted application; never starts registration. */
const getApp = Effect.fn('Lark.getApp')(function*(context: LarkContext) {
  return context.app === undefined ? yield* readState(join(context.directory, 'app.json'), LarkApp)
    : yield* Schema.decodeUnknownEffect(LarkApp)(context.app)
})

/** Reads installation and authorization facts. No state writes or setup actions occur here. */
const inspect = Effect.fn('Lark.inspect')(function*(context: LarkContext) {
  if (!(yield* findCli(context.directory)) || !(yield* hasSkills(context.directory)) ||
      !(yield* readState(join(context.directory, 'installed.json'), Schema.Boolean))) {
    return { state: 'install_required', actionIds: ['install'] }
  }
  const app = yield* getApp(context)
  if (!app) return { state: 'app_required', actionIds: ['create_app'] }
  const appAuth = yield* readState(join(context.directory, 'app-auth.json'), AppAuth)
  const checkedAt = yield* Clock.currentTimeMillis
  if (!appAuth || appAuth.clientId !== app.clientId || appAuth.brand !== app.brand || appAuth.expiresAt <= checkedAt + 60_000) {
    return { state: 'app_authorization_required', actionIds: ['verify_app'] }
  }
  const saved = yield* readState(join(context.directory, 'auth.json'), UserAuth)
  const now = yield* Clock.currentTimeMillis
  const valid = saved && saved.clientId === app.clientId && saved.brand === app.brand &&
    saved.expiresAt > now + 60_000 && saved.scope &&
    larkScopes.every((scope) => saved.scope!.split(/\s+/).includes(scope))
  if (!valid || (yield* userIdentity(app, saved.accessToken)) !== saved.openId) {
    const refreshable = saved && saved.clientId === app.clientId && saved.brand === app.brand &&
      saved.refreshToken && (!saved.refreshExpiresAt || saved.refreshExpiresAt > now + 60_000) &&
      saved.scope && larkScopes.every((scope) => saved.scope!.split(/\s+/).includes(scope))
    return { state: 'login_required', actionIds: refreshable ? ['refresh_auth', 'authorize'] : ['authorize'] }
  }
  return { state: readyState, actionIds: [] }
})

/** Creates only the private integration directory; no vault workspace is created yet. */
const prepareDirectory = Effect.fn('Lark.prepareDirectory')(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
  yield* fs.chmod(directory, 0o700)
})

/** Installs dependencies and upserts resources after explicit host/user confirmation. */
const installConfirmed = Effect.fn('Lark.installConfirmed')(function*(context: LarkContext) {
  yield* context.writeState('installing', {})
  yield* prepareDirectory(context.directory)
  yield* ensureCli(context.directory)
  yield* installSkills(context.directory)
  for (const resource of resources) yield* context.registerResource(resource)
  yield* writeState(join(context.directory, 'installed.json'), true)
})

/** Publishes the next checked state, keeping UI payloads integration-owned. */
const publishCheck = Effect.fn('Lark.publishCheck')(function*(context: LarkContext) {
  const result = yield* inspect(context)
  yield* context.writeState(result.state, { actionIds: result.actionIds })
})

/** Tracks one awaited operation, publishes terminal failure/cancellation, and always clears busy state. */
const runAction = Effect.fn('Lark.runAction')(function*<E, R>(
  context: LarkContext, operation: (context: LarkContext) => Effect.Effect<void, E, R>
) {
  const key = resolve(context.directory)
  const token = Symbol('Lark action')
  const tracked: LarkContext = {
    ...context,
    writeState: (state, data) => context.writeState(state, data).pipe(
      Effect.tap(() => Effect.sync(() => {
        if (active.get(key)?.token === token) active.set(key, { token, result: { state, actionIds: [] } })
      }))
    )
  }
  active.set(key, { token, result: { state: 'working', actionIds: [] } })
  yield* operation(tracked).pipe(Effect.onExit((exit) => Effect.gen(function*() {
    try {
      if (Exit.isFailure(exit)) {
        yield* context.writeState(Exit.hasInterrupts(exit) ? 'cancelled' : 'action_failed', {
          message: Exit.hasInterrupts(exit) ? '操作已取消，请重新检查。' : '操作失败，请重新检查后重试。'
        })
      }
    } finally { active.delete(key) }
  })))
})

/** Runs confirmed installation without registering an app or initiating OAuth. */
const install = Effect.fn('Lark.install')(function*(context: LarkContext) {
  yield* runAction(context, Effect.fn(function*(tracked) {
    yield* installConfirmed(tracked)
    yield* publishCheck(tracked)
  }))
}, lock.withPermit, Effect.mapError(sanitize))

/** Returns live progress immediately during authorization; persisted waiting states are never proof of a live run. */
const check = Effect.fn('Lark.check')(function*(context: LarkContext) {
  const running = active.get(resolve(context.directory))
  return running?.result ?? (yield* inspect(context))
}, Effect.mapError(sanitize))

/** Dispatches static actions only when currently applicable; stale or unknown callbacks fail safely. */
const onActionCallback = Effect.fn('Lark.onActionCallback')(function*(
  context: LarkContext, actionId: string, _payload?: unknown
) {
  if (!actions.some((action) => action.id === actionId)) {
    return yield* new IntegrationError({ message: 'Unknown Lark action.' })
  }
  const current = yield* inspect(context)
  if (!current.actionIds.includes(actionId)) {
    return yield* new IntegrationError({ message: 'This Lark action is no longer available. Check again.' })
  }
  yield* runAction(context, Effect.fn(function*(tracked) {
    if (actionId === 'install') yield* installConfirmed(tracked)
    else {
      yield* prepareDirectory(tracked.directory)
      if (actionId === 'create_app') {
        yield* tracked.writeState('creating_app', {})
        const app = yield* createApp((data) => tracked.writeState('waiting_for_app', data))
        // Preserve credentials even if token exchange fails; retries must not create another app.
        yield* writeState(join(tracked.directory, 'app.json'), app)
        yield* tracked.writeState('verifying_app', {})
        yield* writeState(join(tracked.directory, 'app-auth.json'), yield* authorizeApp(app))
      } else {
        const app = yield* getApp(tracked)
        if (!app) return yield* new IntegrationError({ message: 'Lark application is missing.' })
        yield* writeState(join(tracked.directory, 'app.json'), app)
        if (actionId === 'verify_app') {
          yield* tracked.writeState('verifying_app', {})
          yield* writeState(join(tracked.directory, 'app-auth.json'), yield* authorizeApp(app))
        } else if (actionId === 'refresh_auth') {
          const saved = yield* readState(join(tracked.directory, 'auth.json'), UserAuth)
          if (!saved) return yield* new IntegrationError({ message: 'User authorization is missing.' })
          yield* tracked.writeState('refreshing_auth', {})
          // A successful refresh can invalidate the old pair. Save first; publishCheck verifies
          // the new token and bound user identity before ever publishing ready.
          yield* writeState(join(tracked.directory, 'auth.json'), yield* refreshUser(app, saved))
        } else {
          yield* tracked.writeState('authorizing', {})
          const auth = yield* authorizeUser(app, ({ url, expiresIn }) => tracked.writeState('waiting_for_user', { url, expiresIn }))
          yield* writeState(join(tracked.directory, 'auth.json'), auth)
        }
      }
    }
    yield* publishCheck(tracked)
  }))
}, lock.withPermit, Effect.mapError(sanitize))

export const lark = { id: 'lark', name: 'Lark', actions, resources, install, check, onActionCallback } satisfies Integration
export type { LarkApp } from './state.ts'
