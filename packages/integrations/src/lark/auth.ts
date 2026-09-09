import { Client, Domain, withUserAccessToken } from '@larksuiteoapi/node-sdk'
import { Clock, Effect, Schema } from 'effect'
import { IntegrationError } from '../base/index.ts'
import { AppAuth, LarkApp } from './state.ts'
import type { UserAuth } from './state.ts'

// SDK 1.73.3 treats LoggerLevel.fatal (0) as the default info level. Suppress raw
// transport logs explicitly; all failures leave this module through sanitized errors.
const discardLog = () => {}
const sdkLogger = { error: discardLog, warn: discardLog, info: discardLog, debug: discardLog, trace: discardLog }

/** Distinguishes credentials that need user intervention from retryable transport failures. */
export class AuthorizationRejected extends Schema.TaggedError<AuthorizationRejected>()('AuthorizationRejected', {
  target: Schema.Literals(['app', 'user'])
}) {}

interface AuthorizationRequest { step: 'app' | 'user'; url: string; expiresIn: number }

export const larkScopes = [
  'auth:user.id:read', 'im:chat:read', 'im:message:readonly',
  'im:message.group_msg:get_as_user', 'im:message.p2p_msg:get_as_user', 'im:message.reactions:read',
  'mail:user_mailbox.message.address:read', 'mail:user_mailbox.message.body:read',
  'mail:user_mailbox.message.subject:read', 'mail:user_mailbox.message:readonly', 'mail:user_mailbox:readonly'
]

const DeviceCode = Schema.Struct({
  device_code: Schema.NonEmptyString,
  verification_uri: Schema.NonEmptyString,
  verification_uri_complete: Schema.optional(Schema.String),
  expires_in: Schema.Number.check(Schema.isGreaterThan(0)),
  interval: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0)))
})
const TokenResponse = Schema.Struct({
  error: Schema.optional(Schema.String),
  access_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  refresh_token: Schema.optional(Schema.String),
  refresh_token_expires_in: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  scope: Schema.optional(Schema.String)
})
/** Selects documented endpoints from a validated tenant brand. */
function endpoints(app: LarkApp) {
  return app.brand === 'lark'
    ? { accounts: 'https://accounts.larksuite.com', open: 'https://open.larksuite.com' }
    : { accounts: 'https://accounts.feishu.cn', open: 'https://open.feishu.cn' }
}

/** Fetches and validates auth responses without leaking request credentials or token payloads into errors. */
const request = Effect.fn('Lark.authRequest')(function*<A>(url: string, init: RequestInit, schema: Schema.Codec<A, unknown>) {
  const response = yield* Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, { ...init, signal })
      return { status: response.status, ok: response.ok, body: await response.json() }
    },
    catch: () => new IntegrationError({ message: 'Could not reach the Lark authorization endpoint.' })
  }).pipe(Effect.timeout('30 seconds'))
  if (response.status >= 500 || response.status === 429) return yield* new IntegrationError({ message: 'Lark authorization is temporarily unavailable.' })
  const body = yield* Schema.decodeUnknownEffect(schema)(response.body).pipe(
    Effect.mapError(() => new IntegrationError({ message: `Invalid Lark authorization response (HTTP ${response.status}).` }))
  )
  yield* Effect.logDebug('Lark authorization endpoint responded').pipe(
    Effect.annotateLogs({ httpStatus: response.status, accepted: response.ok })
  )
  return { ...response, body }
})

/** Exchanges app credentials as in kb-wiki; SDK's generated type incorrectly nests these fields under data. */
export const authorizeApp = Effect.fn('Lark.authorizeApp')(function*(app: LarkApp) {
  yield* Effect.logInfo('Lark application authorization started').pipe(Effect.annotateLogs({ brand: app.brand }))
  const now = yield* Clock.currentTimeMillis
  const body = yield* Effect.tryPromise({
    try: (signal) => new Client({
      appId: app.clientId, appSecret: app.clientSecret,
      domain: app.brand === 'lark' ? Domain.Lark : Domain.Feishu,
      disableTokenCache: true, logger: sdkLogger
    }).request<unknown>({
      url: '/open-apis/auth/v3/app_access_token/internal', method: 'POST', signal,
      data: { app_id: app.clientId, app_secret: app.clientSecret }
    }),
    catch: () => new IntegrationError({ message: 'Could not verify Lark application credentials.' })
  }).pipe(Effect.timeout('30 seconds'))
  const result = yield* Schema.decodeUnknownEffect(Schema.Struct({ code: Schema.Number }))(body).pipe(Effect.mapError(() => new IntegrationError({ message: 'Invalid Lark application response.' })))
  if (result.code !== 0) {
    yield* Effect.logWarning('Lark application authorization rejected').pipe(Effect.annotateLogs({ brand: app.brand }))
    return yield* new AuthorizationRejected({ target: 'app' })
  }
  const token = yield* Schema.decodeUnknownEffect(Schema.Struct({
    code: Schema.Literal(0), app_access_token: Schema.NonEmptyString,
    tenant_access_token: Schema.optional(Schema.NonEmptyString),
    expire: Schema.Number.check(Schema.isGreaterThan(0))
  }))(body).pipe(Effect.mapError(() => new IntegrationError({ message: 'Lark rejected application authorization.' })))
  const authorized = {
    clientId: app.clientId, brand: app.brand, appAccessToken: token.app_access_token,
    tenantAccessToken: token.tenant_access_token, expiresAt: now + token.expire * 1000
  } satisfies AppAuth
  yield* Effect.logInfo('Lark application authorization completed').pipe(Effect.annotateLogs({ brand: app.brand }))
  return authorized
}, Effect.annotateLogs({ integration: 'lark', subsystem: 'app-authorization' }), Effect.withLogSpan('lark.authorizeApp'))

/** Verifies a saved token as a user token; network failures do not trigger unnecessary reauthorization. */
export const userIdentity = Effect.fn('Lark.userIdentity')(function*(app: LarkApp, accessToken: string) {
  yield* Effect.logDebug('Lark user identity verification started').pipe(Effect.annotateLogs({ brand: app.brand }))
  const result = yield* Effect.tryPromise({
    try: () => new Client({
      appId: app.clientId, appSecret: app.clientSecret,
      domain: app.brand === 'lark' ? Domain.Lark : Domain.Feishu,
      logger: sdkLogger
    }).authen.userInfo.get({}, withUserAccessToken(accessToken)),
    catch: () => new IntegrationError({ message: 'Lark user verification is temporarily unavailable.' })
  }).pipe(Effect.timeout('30 seconds'))
  if (result.code !== 0) {
    yield* Effect.logWarning('Lark user identity verification rejected').pipe(Effect.annotateLogs({ brand: app.brand }))
    return undefined
  }
  yield* Effect.logDebug('Lark user identity verification completed').pipe(
    Effect.annotateLogs({ brand: app.brand, identityPresent: !!result.data?.open_id })
  )
  return result.data?.open_id

}, Effect.annotateLogs({ integration: 'lark', subsystem: 'user-verification' }), Effect.withLogSpan('lark.userIdentity'))

/** Runs device OAuth, forwarding its URL to the host and respecting expiry, slow_down, and cancellation. */
export const authorizeUser = Effect.fn('Lark.authorizeUser')(function*(
  app: LarkApp, onAuthorize: (request: AuthorizationRequest) => Effect.Effect<void, IntegrationError>
) {
  yield* Effect.logDebug('Lark device authorization requested').pipe(Effect.annotateLogs({ brand: app.brand }))
  const scope = [...larkScopes, 'offline_access'].join(' ')
  const started = yield* request(`${endpoints(app).accounts}/oauth/v1/device_authorization`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ client_id: app.clientId, scope }).toString()
  }, DeviceCode)
  if (!started.ok) return yield* new IntegrationError({ message: 'Lark rejected the application credentials or requested scopes.' })
  const device = started.body
  const deadline = (yield* Clock.currentTimeMillis) + device.expires_in * 1000
  yield* Effect.logDebug('Lark device authorization accepted').pipe(
    Effect.annotateLogs({ expiresInSeconds: device.expires_in, pollingIntervalSeconds: device.interval ?? 5 })
  )
  yield* onAuthorize({
    step: 'user', url: device.verification_uri_complete || device.verification_uri, expiresIn: device.expires_in
  })
  let interval = Math.max(device.interval ?? 5, 1)
  let attempt = 0
  while ((yield* Clock.currentTimeMillis) < deadline) {
    yield* Effect.sleep(Math.min(interval * 1000, deadline - (yield* Clock.currentTimeMillis)))
    if ((yield* Clock.currentTimeMillis) >= deadline) break
    const response = yield* request(`${endpoints(app).open}/open-apis/authen/v2/oauth/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret,
        device_code: device.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }).toString()
    }, TokenResponse)
    attempt++
    const token = response.body
    if (token.error === 'authorization_pending') {
      yield* Effect.logDebug('Lark user authorization is pending').pipe(Effect.annotateLogs({ attempt }))
      continue
    }
    if (token.error === 'slow_down') {
      interval = Math.min(interval + 5, 60)
      yield* Effect.logWarning('Lark authorization polling slowed down').pipe(
        Effect.annotateLogs({ attempt, pollingIntervalSeconds: interval })
      )
      continue
    }
    if (!response.ok || token.error || !token.access_token || !token.expires_in) {
      return yield* new IntegrationError({ message: 'Lark user authorization was denied, expired, or returned an invalid token.' })
    }
    if (token.scope && larkScopes.some((required) => !token.scope!.split(/\s+/).includes(required))) {
      return yield* new IntegrationError({ message: 'Lark did not grant all requested Lark permissions.' })
    }
    const now = yield* Clock.currentTimeMillis
    const openId = yield* userIdentity(app, token.access_token)
    if (!openId) return yield* new IntegrationError({ message: 'Lark rejected the authorized user token.' })
    const authorized = {
      clientId: app.clientId, brand: app.brand, accessToken: token.access_token,
      expiresAt: now + token.expires_in * 1000, refreshToken: token.refresh_token,
      refreshExpiresAt: token.refresh_token_expires_in ? now + token.refresh_token_expires_in * 1000 : undefined,
      scope: token.scope ?? scope, openId
    } satisfies UserAuth
    yield* Effect.logDebug('Lark user token granted').pipe(Effect.annotateLogs({ attempt, brand: app.brand }))
    return authorized
  }
  yield* Effect.logWarning('Lark user authorization expired before completion')
  return yield* new IntegrationError({ message: 'Lark user authorization expired. Start installation again.' })
}, Effect.annotateLogs({ integration: 'lark', subsystem: 'user-authorization' }), Effect.withLogSpan('lark.authorizeUser'))

/** Exchanges the refresh token; persist the rotated pair before remote verification to survive network failures. */
export const refreshUser = Effect.fn('Lark.refreshUser')(function*(app: LarkApp, saved: UserAuth) {
  yield* Effect.logInfo('Lark user authorization refresh started').pipe(Effect.annotateLogs({ brand: app.brand }))
  if (!saved.refreshToken) return yield* new AuthorizationRejected({ target: 'user' })
  const result = yield* request(`${endpoints(app).open}/open-apis/authen/v2/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret,
      grant_type: 'refresh_token', refresh_token: saved.refreshToken }).toString()
  }, TokenResponse)
  const token = result.body
  if (token.error && ['invalid_grant', 'invalid_token', 'access_denied'].includes(token.error)) {
    return yield* new AuthorizationRejected({ target: 'user' })
  }
  if (token.error && ['invalid_client', 'unauthorized_client'].includes(token.error)) {
    return yield* new AuthorizationRejected({ target: 'app' })
  }
  if (!result.ok || token.error || !token.access_token || !token.expires_in) {
    return yield* new IntegrationError({ message: 'Lark could not refresh authorization. Retrying automatically.' })
  }
  const scope = token.scope ?? saved.scope
  if (!scope || larkScopes.some((required) => !scope.split(/\s+/).includes(required))) {
    return yield* new AuthorizationRejected({ target: 'user' })
  }
  const now = yield* Clock.currentTimeMillis
  const refreshed = {
    ...saved, accessToken: token.access_token, expiresAt: now + token.expires_in * 1000,
    refreshToken: token.refresh_token || saved.refreshToken,
    refreshExpiresAt: token.refresh_token_expires_in
      ? now + token.refresh_token_expires_in * 1000 : saved.refreshExpiresAt, scope
  } satisfies UserAuth
  yield* Effect.logInfo('Lark user authorization refresh completed').pipe(Effect.annotateLogs({ brand: app.brand }))
  return refreshed
}, Effect.annotateLogs({ integration: 'lark', subsystem: 'user-authorization' }), Effect.withLogSpan('lark.refreshUser'))
