import { Clock, Effect, FileSystem, Schema } from 'effect'
import { join } from 'node:path'
import { defineIntegration, IntegrationError, readyState } from '../base/index.ts'
import type { IngestContext, IntegrationContext } from '../base/index.ts'
import { authorizeApp, authorizeUser, larkScopes, refreshUser, userIdentity } from './auth.ts'
import { larkMetadata } from './metadata.ts'
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

/** Performs Lark actions after the base validates the static ID and current availability. */
const onActionCallback = Effect.fn('Lark.onActionCallback')(function*(
  context: LarkContext, actionId: string, _payload?: unknown
) {
  if (actionId === 'install') yield* installConfirmed(context)
  else {
    yield* prepareDirectory(context.directory)
    if (actionId === 'create_app') {
      yield* context.writeState('creating_app', {})
      const app = yield* createApp((data) => context.writeState('waiting_for_app', data))
      // Preserve credentials even if token exchange fails; retries must not create another app.
      yield* writeState(join(context.directory, 'app.json'), app)
      yield* context.writeState('verifying_app', {})
      yield* writeState(join(context.directory, 'app-auth.json'), yield* authorizeApp(app))
    } else {
      const app = yield* getApp(context)
      if (!app) return yield* new IntegrationError({ message: 'Lark application is missing.' })
      yield* writeState(join(context.directory, 'app.json'), app)
      if (actionId === 'verify_app') {
        yield* context.writeState('verifying_app', {})
        yield* writeState(join(context.directory, 'app-auth.json'), yield* authorizeApp(app))
      } else if (actionId === 'refresh_auth') {
        const saved = yield* readState(join(context.directory, 'auth.json'), UserAuth)
        if (!saved) return yield* new IntegrationError({ message: 'User authorization is missing.' })
        yield* context.writeState('refreshing_auth', {})
        // A successful refresh can invalidate the old pair. Save first; the base's final check verifies
        // the new token and bound user identity before ever publishing ready.
        yield* writeState(join(context.directory, 'auth.json'), yield* refreshUser(app, saved))
      } else {
        yield* context.writeState('authorizing', {})
        const auth = yield* authorizeUser(app, ({ url, expiresIn }) => context.writeState('waiting_for_user', { url, expiresIn }))
        yield* writeState(join(context.directory, 'auth.json'), auth)
      }
    }
  }
})

export const lark = defineIntegration<LarkContext>({
  ...larkMetadata, actions, resources, install: installConfirmed, check: inspect, onActionCallback
})
export type { LarkApp } from './state.ts'
