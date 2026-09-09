import { Client, Domain, registerApp, withUserAccessToken } from '@larksuiteoapi/node-sdk'
import { Clock, Context, Effect, Layer, Schema } from 'effect'
import { IntegrationError } from '../base/index.ts'
import type { AppAuth, LarkApp, UserAuth } from './state.ts'

// SDK 1.73.3 treats LoggerLevel.fatal (0) as the default info level. Suppress raw
// transport logs explicitly; all failures leave this module through sanitized errors.
const discardLog = () => {}
const sdkLogger = { error: discardLog, warn: discardLog, info: discardLog, debug: discardLog, trace: discardLog }

/** Distinguishes credentials that need user intervention from retryable transport failures. */
export class AuthorizationRejected extends Schema.TaggedError<AuthorizationRejected>()('AuthorizationRejected', {
  target: Schema.Literals(['app', 'user'])
}) {}

export interface AuthorizationRequest { readonly step: 'app' | 'user'; readonly url: string; readonly expiresIn: number }
export interface RegistrationProgress {
  readonly url?: string
  readonly expiresAt?: number
  readonly status: 'starting' | 'polling' | 'slow_down' | 'domain_switched'
  readonly interval?: number
}

export const larkScopes = [
  'auth:user.id:read', 'im:chat:read', 'im:message:readonly',
  'im:message.group_msg:get_as_user', 'im:message.p2p_msg:get_as_user', 'im:message.reactions:read',
  'mail:user_mailbox.message.address:read', 'mail:user_mailbox.message.body:read',
  'mail:user_mailbox.message.subject:read', 'mail:user_mailbox.message:readonly', 'mail:user_mailbox:readonly'
] as const

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
const request = Effect.fn('LarkService.request')(function*<A>(url: string, init: RequestInit, schema: Schema.Codec<A, unknown>) {
  const response = yield* Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, { ...init, signal })
      return { status: response.status, ok: response.ok, body: await response.json() }
    },
    catch: () => new IntegrationError({ message: 'Could not reach the Lark authorization endpoint.' })
  }).pipe(Effect.timeout('30 seconds'))
  if (response.status >= 500 || response.status === 429) {
    return yield* new IntegrationError({ message: 'Lark authorization is temporarily unavailable.' })
  }
  const body = yield* Schema.decodeUnknownEffect(schema)(response.body).pipe(
    Effect.mapError(() => new IntegrationError({ message: `Invalid Lark authorization response (HTTP ${response.status}).` }))
  )
  yield* Effect.logDebug('Lark authorization endpoint responded').pipe(
    Effect.annotateLogs({ httpStatus: response.status, accepted: response.ok })
  )
  return { ...response, body }
})

const createApp = Effect.fn('LarkService.createApp')(function*(
  onProgress: (data: RegistrationProgress) => Effect.Effect<void, IntegrationError>
) {
  yield* Effect.logInfo('Lark application registration started')
  yield* Effect.logDebug('Lark registration SDK started')
  const result = yield* Effect.tryPromise({
    try: async (signal) => {
      const controller = new AbortController()
      const combined = AbortSignal.any([signal, controller.signal])
      let progress: RegistrationProgress = { status: 'starting' }
      let writes = Promise.resolve()
      let rejectWrite!: (error: unknown) => void
      const failedWrite = new Promise<never>((_, reject) => { rejectWrite = reject })
      // All callback updates preserve the URL and are committed in SDK event order.
      const publish = (update: Partial<RegistrationProgress>) => {
        if (combined.aborted) return
        const next = { ...progress, ...update }
        if (JSON.stringify(next) === JSON.stringify(progress)) return
        progress = next
        const snapshot = progress
        writes = writes.then(() => Effect.runPromise(onProgress(snapshot), { signal: combined }))
        void writes.catch((error) => { rejectWrite(error); controller.abort() })
      }
      try {
        const registration = registerApp({
          source: 'folio', signal: combined,
          appPreset: { name: 'Folio', desc: 'Personal Wiki information ingestion' },
          addons: { scopes: { user: [...larkScopes] } },
          onQRCodeReady: ({ url, expireIn }) => publish({ url, expiresAt: Date.now() + expireIn * 1000 }),
          onStatusChange: ({ status, interval }) => publish({ status, interval })
        })
        const result = await Promise.race([registration, failedWrite])
        await writes
        return result
      } finally { controller.abort() }
    },
    catch: () => new IntegrationError({ message: 'Lark application registration failed or expired. Try again.' })
  })
  const app = yield* Schema.decodeUnknownEffect(Schema.Struct({
    clientId: Schema.NonEmptyString,
    clientSecret: Schema.NonEmptyString,
    brand: Schema.Literals(['feishu', 'lark'])
  }))({
    clientId: result.client_id, clientSecret: result.client_secret,
    brand: result.user_info?.tenant_brand === 'lark' ? 'lark' : 'feishu'
  }).pipe(Effect.mapError(() => new IntegrationError({ message: 'Lark returned invalid application credentials.' })))
  yield* Effect.logDebug('Lark registration SDK completed').pipe(Effect.annotateLogs({ brand: app.brand }))
  yield* Effect.logInfo('Lark application registration completed').pipe(Effect.annotateLogs({ brand: app.brand }))
  return app
}, Effect.tapError(() => Effect.logWarning('Lark registration SDK failed')),
Effect.annotateLogs({ integration: 'lark', subsystem: 'service' }), Effect.withLogSpan('lark.service.createApp'))

/** Exchanges app credentials; SDK's generated type incorrectly nests these fields under data. */
const authorizeApp = Effect.fn('LarkService.authorizeApp')(function*(app: LarkApp) {
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
  const result = yield* Schema.decodeUnknownEffect(Schema.Struct({ code: Schema.Number }))(body).pipe(
    Effect.mapError(() => new IntegrationError({ message: 'Invalid Lark application response.' }))
  )
  if (result.code !== 0) return yield* new AuthorizationRejected({ target: 'app' })
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
}, Effect.annotateLogs({ integration: 'lark', subsystem: 'service' }), Effect.withLogSpan('lark.service.authorizeApp'))

/** Verifies a saved token as a user token; network failures do not trigger unnecessary reauthorization. */
const userIdentity = Effect.fn('LarkService.userIdentity')(function*(app: LarkApp, accessToken: string) {
  const result = yield* Effect.tryPromise({
    try: () => new Client({
      appId: app.clientId, appSecret: app.clientSecret,
      domain: app.brand === 'lark' ? Domain.Lark : Domain.Feishu,
      logger: sdkLogger
    }).authen.userInfo.get({}, withUserAccessToken(accessToken)),
    catch: () => new IntegrationError({ message: 'Lark user verification is temporarily unavailable.' })
  }).pipe(Effect.timeout('30 seconds'))
  if (result.code !== 0) return undefined
  return result.data?.open_id
}, Effect.annotateLogs({ integration: 'lark', subsystem: 'service' }), Effect.withLogSpan('lark.service.userIdentity'))

/** Runs device OAuth, forwarding its URL to the host and respecting expiry, slow_down, and cancellation. */
const authorizeUser = Effect.fn('LarkService.authorizeUser')(function*(
  app: LarkApp, onAuthorize: (request: AuthorizationRequest) => Effect.Effect<void, IntegrationError>
) {
  yield* Effect.logInfo('Lark user authorization started').pipe(Effect.annotateLogs({ brand: app.brand }))
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
    if (token.error === 'authorization_pending') continue
    if (token.error === 'slow_down') {
      interval = Math.min(interval + 5, 60)
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
    yield* Effect.logInfo('Lark user authorization completed').pipe(Effect.annotateLogs({ brand: app.brand }))
    return authorized
  }
  return yield* new IntegrationError({ message: 'Lark user authorization expired. Start installation again.' })
}, Effect.annotateLogs({ integration: 'lark', subsystem: 'service' }), Effect.withLogSpan('lark.service.authorizeUser'))

/** Exchanges a refresh token without reading or writing Folio state. */
const refreshUser = Effect.fn('LarkService.refreshUser')(function*(app: LarkApp, saved: UserAuth) {
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
  return {
    ...saved, accessToken: token.access_token, expiresAt: now + token.expires_in * 1000,
    refreshToken: token.refresh_token || saved.refreshToken,
    refreshExpiresAt: token.refresh_token_expires_in
      ? now + token.refresh_token_expires_in * 1000 : saved.refreshExpiresAt, scope
  } satisfies UserAuth
}, Effect.annotateLogs({ integration: 'lark', subsystem: 'service' }), Effect.withLogSpan('lark.service.refreshUser'))

export interface LarkServiceApi {
  readonly createApp: typeof createApp
  readonly authorizeApp: typeof authorizeApp
  readonly authorizeUser: typeof authorizeUser
  readonly refreshUser: typeof refreshUser
  readonly userIdentity: typeof userIdentity
}

/** Remote boundary for every Lark SDK and HTTP authorization operation. */
export class LarkService extends Context.Service<LarkService, LarkServiceApi>()('@folio/integrations/lark/LarkService') {
  static readonly layer = Layer.succeed(LarkService, LarkService.of({
    createApp, authorizeApp, authorizeUser, refreshUser, userIdentity
  }))
}
