import { Clock, Effect, Fiber } from 'effect'
import { OAuth2Client } from 'google-auth-library'
import { gmail_v1 } from 'googleapis/build/src/apis/gmail/v1.js'
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { IntegrationError } from '../base/index.ts'
import { GmailCredentials, readPrivateState, updatePrivateState } from './state.ts'

export const gmailScope = 'https://www.googleapis.com/auth/gmail.readonly'
const tokenEndpoint = 'https://oauth2.googleapis.com/token'
const authorizationEndpoint = 'https://accounts.google.com/o/oauth2/v2/auth'
const callbackPath = '/oauth2callback'
/**
 * Resolves the proxy once per request so a desktop launcher can provide or
 * change its environment before a connection attempt. Gaxios also checks these
 * variables internally, but passing the value explicitly keeps Gmail's OAuth
 * transport proxy-aware even when that default behavior changes.
 */
const gmailProxy = (): string | undefined => {
  const value = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
  const trimmed = value?.trim()
  return trimmed || undefined
}

/** Creates a Google SDK client with the same explicit proxy selection as OAuth. */
const googleOAuthClient = (clientId: string, clientSecret: string): OAuth2Client => {
  const proxy = gmailProxy()
  return new OAuth2Client({
    clientId,
    clientSecret,
    ...(proxy ? { transporterOptions: { proxy } } : {})
  })
}

export const hasGmailScope = (scope: string | undefined): boolean => !scope || scope.split(/\s+/).includes(gmailScope)

const objectString = (body: unknown, key: string): string | undefined =>
  typeof body === 'object' && body !== null && key in body && typeof body[key as keyof typeof body] === 'string' ? (body[key as keyof typeof body] as string) : undefined
/** Logs SDK failures without serializing request config or OAuth credentials. */
const logGoogleSdkError = (endpoint: string, cause: unknown): void => {
  const value =
    typeof cause === 'object' && cause !== null
      ? (cause as {
          code?: unknown
          response?: { status?: unknown; data?: unknown }
        })
      : undefined
  const data = value?.response?.data
  const message = cause instanceof Error ? cause.message.slice(0, 300) : 'Unknown Google SDK error'
  console.error('[Folio][Gmail OAuth] Google SDK request failed', {
    endpoint,
    status: typeof value?.response?.status === 'number' ? value.response.status : undefined,
    error: objectString(data, 'error') ?? (typeof value?.code === 'string' ? value.code : undefined),
    errorDescription: objectString(data, 'error_description'),
    message,
    proxyConfigured: Boolean(gmailProxy())
  })
}

/** Starts the loopback listener used by Google's Desktop OAuth client flow. */
const listenLoopback = (server: Server) =>
  Effect.tryPromise<string, IntegrationError>({
    try: (signal) =>
      new Promise<string>((resolve, reject) => {
        let settled = false
        const finish = (callback: () => void) => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', onAbort)
          server.removeListener('error', onError)
          callback()
        }
        const onError = (cause: unknown) => finish(() => reject(cause))
        const onAbort = () => {
          // Closing a listener that is still starting is harmless; the abort error
          // is mapped below to the same safe integration failure as other startup
          // errors.
          if (server.listening) server.close(() => undefined)
          finish(() => reject(new Error('OAuth callback listener was interrupted.')))
        }
        server.once('error', onError)
        signal.addEventListener('abort', onAbort, { once: true })
        server.listen(0, '127.0.0.1', () => {
          const address = server.address()
          if (!address || typeof address === 'string') return finish(() => reject(new Error('OAuth callback listener did not expose a port.')))
          finish(() => resolve(`http://127.0.0.1:${address.port}${callbackPath}`))
        })
      }),
    catch: (cause) => {
      console.error('[Folio][Gmail OAuth] callback listener error', {
        error: cause instanceof Error ? cause.message.slice(0, 300) : 'Unknown callback listener error',
        proxyConfigured: Boolean(gmailProxy())
      })
      return new IntegrationError({ message: 'Could not start the local Gmail authorization callback.' })
    }
  })

/**
 * Closes the loopback listener without waiting for browser keep-alive sockets.
 * Chromium may retain a preconnected localhost socket after rendering the
 * success page; awaiting `server.close()` would then leave the OAuth operation
 * permanently stuck in its finalizer.
 */
const closeLoopback = (server: Server) =>
  Effect.sync(() => {
    if (server.listening) server.close()
    server.closeAllConnections()
  })

/** Waits for one validated OAuth redirect and never exposes the authorization code in logs. */
const waitForAuthorizationCode = (server: Server, redirectUri: string, expectedState: string) =>
  Effect.tryPromise<string, IntegrationError>({
    try: (signal) =>
      new Promise<string>((resolve, reject) => {
        const redirect = new URL(redirectUri)
        let settled = false
        const timeout = setTimeout(() => finish(() => reject(new IntegrationError({ message: 'Google authorization timed out. Start Gmail connection again.' }))), 10 * 60_000)
        const cleanup = () => {
          clearTimeout(timeout)
          signal.removeEventListener('abort', onAbort)
          server.removeListener('request', onRequest)
          server.removeListener('error', onError)
        }
        const finish = (callback: () => void) => {
          if (settled) return
          settled = true
          cleanup()
          callback()
        }
        const reply = (response: { statusCode: number; setHeader(name: string, value: string): void; end(body: string): void }, statusCode: number, body: string) => {
          response.statusCode = statusCode
          response.setHeader('content-type', 'text/plain; charset=utf-8')
          response.setHeader('connection', 'close')
          response.end(body)
        }
        const onError = (cause: unknown) => finish(() => reject(cause))
        const onAbort = () => finish(() => reject(new Error('OAuth authorization was interrupted.')))
        const onRequest = (request: { method?: string; url?: string }, response: { statusCode: number; setHeader(name: string, value: string): void; end(body: string): void }) => {
          let incoming: URL
          try {
            incoming = new URL(request.url ?? '/', redirect)
          } catch {
            return reply(response, 400, 'Invalid callback URL.')
          }
          // Ignore browser probes (favicon, captive-portal checks, etc.) and only
          // consume the exact redirect endpoint Google was given.
          if (request.method !== 'GET' || incoming.pathname !== redirect.pathname) return reply(response, 404, 'Not found.')
          if (incoming.searchParams.get('state') !== expectedState) {
            reply(response, 400, 'Invalid OAuth state. You can close this window and retry in Folio.')
            return finish(() => reject(new IntegrationError({ message: 'Google returned an invalid authorization state.' })))
          }
          const oauthError = incoming.searchParams.get('error')
          if (oauthError) {
            const description = incoming.searchParams.get('error_description')
            reply(response, 400, 'Google authorization was not completed. You can close this window.')
            return finish(() => reject(new IntegrationError({ message: `Google authorization failed: ${oauthError}${description ? `: ${description}` : ''}` })))
          }
          const code = incoming.searchParams.get('code')
          if (!code) {
            reply(response, 400, 'Google did not return an authorization code.')
            return finish(() => reject(new IntegrationError({ message: 'Google returned an incomplete authorization response.' })))
          }
          // Keep the browser response independent from token exchange. The
          // caller advances its durable state before contacting Google again.
          reply(response, 200, 'Gmail authorization completed. You can return to Folio.')
          console.info('[Folio][Gmail OAuth] authorization callback received', {
            host: redirect.hostname,
            port: redirect.port
          })
          finish(() => resolve(code))
        }
        server.on('request', onRequest)
        server.once('error', onError)
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    catch: (cause) => {
      if (cause instanceof IntegrationError) return cause
      console.error('[Folio][Gmail OAuth] callback error', {
        error: cause instanceof Error ? cause.message.slice(0, 300) : 'Unknown callback error',
        proxyConfigured: Boolean(gmailProxy())
      })
      return new IntegrationError({ message: 'Could not receive the Gmail authorization callback.' })
    }
  })

type AuthorizationCodeToken = { readonly accessToken: string; readonly refreshToken: string; readonly expiresAt: number; readonly scope?: string }

/** Implements the OAuth authorization-code flow required by Google's Desktop application clients. */
export const authorizeDesktop = Effect.fn('Gmail.authorizeDesktop')(function* (
  clientId: string,
  clientSecret: string,
  onAuthorizationUrl: (url: string) => Effect.Effect<void, IntegrationError>,
  onAuthorizationCode?: () => Effect.Effect<void, IntegrationError>
) {
  const server = createServer()
  return yield* Effect.gen(function* () {
    const redirectUri = yield* listenLoopback(server)
    const client = googleOAuthClient(clientId, clientSecret)
    const state = randomBytes(32).toString('hex')
    const authorizationUrl = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: gmailScope,
      state,
      redirect_uri: redirectUri
    })
    // Keep this assertion close to URL generation so a future SDK change
    // cannot silently send a non-Google URL to the host browser adapter.
    if (!authorizationUrl.startsWith(`${authorizationEndpoint}?`)) return yield* new IntegrationError({ message: 'Google returned an invalid authorization URL.' })
    // Install the callback before publishing its URL; the browser may redirect
    // while the host is still committing the visible authorization state.
    const callback = yield* waitForAuthorizationCode(server, redirectUri, state).pipe(Effect.forkScoped({ startImmediately: true }))
    yield* onAuthorizationUrl(authorizationUrl)
    const code = yield* Fiber.join(callback)
    if (onAuthorizationCode) yield* onAuthorizationCode()
    const token = yield* Effect.tryPromise({
      try: () => client.getToken({ code, redirect_uri: redirectUri }),
      catch: (cause) => {
        logGoogleSdkError(tokenEndpoint, cause)
        return new IntegrationError({ message: 'Could not exchange the Gmail authorization code with Google.' })
      }
    })
    const accessToken = token.tokens.access_token
    const refreshToken = token.tokens.refresh_token
    const expiresAt = token.tokens.expiry_date
    if (!accessToken || !refreshToken || !expiresAt) {
      return yield* new IntegrationError({ message: 'Google did not return a Gmail refresh token. Revoke the app in your Google account and authorize again.' })
    }
    return {
      accessToken,
      refreshToken,
      expiresAt,
      scope: token.tokens.scope
    } satisfies AuthorizationCodeToken
  }).pipe(Effect.scoped, Effect.ensuring(closeLoopback(server)))
})

const refresh = Effect.fn('Gmail.refresh')(function* (credentials: GmailCredentials) {
  // google-auth-library (through the official googleapis package) owns the
  // refresh-token exchange and expiry bookkeeping.
  const client = googleOAuthClient(credentials.clientId, credentials.clientSecret)
  client.setCredentials({
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
    expiry_date: credentials.expiresAt,
    scope: credentials.scope
  })
  const token = yield* Effect.tryPromise({
    try: () => client.getAccessToken(),
    catch: (cause) => {
      logGoogleSdkError(tokenEndpoint, cause)
      return new IntegrationError({ message: 'Could not refresh Gmail authorization with Google.' })
    }
  })
  const accessToken = token.token
  const expiresAt = client.credentials.expiry_date
  if (!accessToken || !expiresAt) return yield* new IntegrationError({ message: 'Google returned an incomplete Gmail refresh token.' })
  return {
    ...credentials,
    accessToken,
    expiresAt,
    scope: client.credentials.scope ?? credentials.scope,
    verified: false
  }
})

export const maintainCredentials = Effect.fn('Gmail.maintainCredentials')(function* (directory: string) {
  const state = yield* readPrivateState(directory)
  const credentials = state.credentials
  if (!credentials) return yield* new IntegrationError({ message: 'Gmail authorization is incomplete.' })
  if (credentials.expiresAt <= (yield* Clock.currentTimeMillis) + 60_000) {
    const next = yield* refresh(credentials)
    yield* updatePrivateState(directory, { credentials: next })
    return next
  }
  return credentials
})

export const verifyCredentials = Effect.fn('Gmail.verifyCredentials')(function* (credentials: GmailCredentials) {
  if (!hasGmailScope(credentials.scope)) return yield* new IntegrationError({ message: 'Gmail authorization does not include the read-only Gmail scope.' })
  // Use the generated Gmail client for the health check so API paths, auth
  // headers, and response decoding stay aligned with Google's supported SDK.
  const client = googleOAuthClient(credentials.clientId, credentials.clientSecret)
  client.setCredentials({ access_token: credentials.accessToken })
  const api = new gmail_v1.Gmail({ auth: client })
  const profile = yield* Effect.tryPromise({
    try: () => api.users.getProfile({ userId: 'me' }),
    catch: (cause) => {
      logGoogleSdkError('https://gmail.googleapis.com/gmail/v1/users/me/profile', cause)
      return new IntegrationError({ message: 'Gmail authorization is no longer valid.' })
    }
  })
  if (!profile.data.emailAddress) return yield* new IntegrationError({ message: 'Gmail returned an invalid profile.' })
})
