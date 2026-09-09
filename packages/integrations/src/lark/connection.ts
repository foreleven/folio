import { Clock, Context, Effect, Schema, Semaphore } from 'effect'
import { resolve } from 'node:path'
import { IntegrationContext } from '../base/index.ts'
import { AuthorizationRejected, authorizeApp, larkScopes, refreshUser, userIdentity } from './auth.ts'
import { LarkApp, readPrivateState, updatePrivateState } from './state.ts'
import type { UserAuth } from './state.ts'

/** Optional host credentials; omitted values reuse the existing private application file. */
export const LarkApplication = Context.Reference<LarkApp | undefined>('@folio/integrations/lark/LarkApplication', {
  defaultValue: () => undefined
})

/** Only runtime coordination lives in memory; tokens and verification survive process restarts. */
const sessions = new Map<string, { lock: Semaphore.Semaphore; rejected?: 'app' | 'user'; failures: number }>()
export const session = Effect.fn('Lark.session')(function*() {
  const { directory } = yield* IntegrationContext
  const key = resolve(directory)
  // Lookup and allocation are synchronous so two first callers cannot acquire different locks.
  return yield* Effect.sync(() => {
    let current = sessions.get(key)
    if (!current) {
      current = { lock: Semaphore.makeUnsafe(1), failures: 0 }
      sessions.set(key, current)
    }
    return current
  })
})

/** Resolves a supplied or persisted application without creating or changing it. */
export const getApp = Effect.fn('Lark.getApp')(function*() {
  const { directory } = yield* IntegrationContext
  const supplied = yield* LarkApplication
  const app = supplied === undefined ? (yield* readPrivateState(directory)).app
    : yield* Schema.decodeUnknownEffect(LarkApp)(supplied)
  yield* Effect.logDebug('Lark application credentials resolved').pipe(
    Effect.annotateLogs({ source: supplied === undefined ? 'saved' : 'host', present: app !== undefined })
  )
  return app
}, Effect.annotateLogs({ integration: 'lark', subsystem: 'connection-state' }))

/** Saved credentials are usable only for this app/brand and the full requested resource scope. */
export function belongsToApp(saved: { clientId: string; brand: string } | undefined, app: LarkApp): boolean {
  return saved?.clientId === app.clientId && saved.brand === app.brand
}

/** Scope changes require a new user grant; refreshing cannot manufacture missing permissions. */
export function hasPermissions(saved: UserAuth | undefined): boolean {
  return !!saved?.scope && larkScopes.every((scope) => saved.scope!.split(/\s+/).includes(scope))
}

/** Renews expiring credentials under the caller's installation lock; never initiates OAuth. */
export const maintain = Effect.fn('Lark.maintain')(function*() {
  const { directory } = yield* IntegrationContext
  const current = yield* session()
  yield* Effect.logDebug('Lark credential maintenance started')
  const app = yield* getApp()
  if (!app) {
    yield* Effect.logDebug('Lark credential maintenance skipped').pipe(Effect.annotateLogs({ reason: 'app_missing' }))
    return
  }
  if (current.rejected) {
    yield* Effect.logDebug('Lark credential maintenance skipped').pipe(
      Effect.annotateLogs({ reason: 'authorization_rejected', target: current.rejected })
    )
    return
  }
  const now = yield* Clock.currentTimeMillis
  let privateState = yield* readPrivateState(directory)
  const appAuth = privateState.appAuth
  if (!appAuth || !belongsToApp(appAuth, app) || appAuth.expiresAt <= now + 60_000) {
    yield* Effect.logInfo('Lark application credentials require authorization').pipe(
      Effect.annotateLogs({ reason: !appAuth ? 'missing' : !belongsToApp(appAuth, app) ? 'application_changed' : 'expiring' })
    )
    privateState = yield* updatePrivateState(directory, { appAuth: yield* authorizeApp(app) })
  }
  let saved = privateState.userAuth
  if (!saved || !belongsToApp(saved, app) || !hasPermissions(saved)) {
    yield* Effect.logDebug('Lark user credentials are not maintainable').pipe(
      Effect.annotateLogs({ reason: !saved ? 'missing' : !belongsToApp(saved, app) ? 'application_changed' : 'scope_changed' })
    )
    return
  }
  if (saved.expiresAt <= now + 60_000 && saved.refreshToken &&
      (!saved.refreshExpiresAt || saved.refreshExpiresAt > now)) {
    yield* Effect.logInfo('Lark user credentials require refresh')
    saved = { ...yield* refreshUser(app, saved), verified: false }
    // Rotating the refresh token may invalidate the old pair. Commit before remote verification.
    yield* updatePrivateState(directory, { userAuth: saved })
  }
  if (saved.expiresAt <= now) {
    yield* Effect.logWarning('Lark user credentials expired without a usable refresh grant')
    return
  }
  const identity = yield* userIdentity(app, saved.accessToken)
  if (identity !== saved.openId) {
    yield* updatePrivateState(directory, { userAuth: { ...saved, verified: false } })
    yield* Effect.logWarning('Lark user credential verification rejected')
    return yield* new AuthorizationRejected({ target: 'user' })
  }
  if (saved.verified === false) yield* updatePrivateState(directory, { userAuth: { ...saved, verified: true } })
  yield* Effect.logDebug('Lark credential maintenance completed')
}, Effect.annotateLogs({ integration: 'lark', subsystem: 'credential-maintenance' }),
Effect.withLogSpan('lark.maintain'))

/** Remembers only rejection categories, never credential-bearing diagnostics. Transient errors remain retryable. */
export const recover = maintain().pipe(
  Effect.tap(() => Effect.flatMap(session(), (current) => Effect.sync(() => { current.failures = 0 }))),
  Effect.catch((error) => Effect.gen(function*() {
    const current = yield* session()
    current.failures++
    if (error instanceof AuthorizationRejected) current.rejected = error.target
    yield* Effect.logWarning('Lark credential maintenance will retry').pipe(Effect.annotateLogs({
      failureCount: current.failures,
      category: error instanceof AuthorizationRejected ? 'authorization_rejected' : 'transient',
      target: error instanceof AuthorizationRejected ? error.target : 'none'
    }))
  })),
  Effect.annotateLogs({ integration: 'lark', subsystem: 'credential-maintenance' })
)

/** Lark chooses its own renewal deadline/backoff. Short idle wakes notice newly completed authorizations. */
export const nextMaintenance = Effect.fn('Lark.nextMaintenance')(function*() {
  const { directory } = yield* IntegrationContext
  const current = yield* session()
  const now = yield* Clock.currentTimeMillis
  const privateState = yield* readPrivateState(directory)
  const app = privateState.appAuth
  const user = privateState.userAuth
  if (current.failures) {
    // Retry before a still-valid token expires so the UI can reflect actual loss of availability.
    const expiresIn = Math.min(app?.expiresAt ?? Infinity, user?.expiresAt ?? Infinity) - now
    return Math.max(1000, Math.min(30_000 * 2 ** Math.min(current.failures - 1, 3), expiresIn > 0 ? expiresIn : Infinity))
  }
  const due = Math.min(app?.expiresAt ?? Infinity, user?.expiresAt ?? Infinity) - now - 60_000
  return due > 0 ? Math.min(due, 60_000) : 30_000
})

/** Releases installation-local coordination after the host interrupts the provider runtime. */
export const releaseSession = Effect.gen(function*() {
  const { directory } = yield* IntegrationContext
  sessions.delete(resolve(directory))
  yield* Effect.logDebug('Lark runtime session released').pipe(
    Effect.annotateLogs({ integration: 'lark', subsystem: 'connection-state' })
  )
})
