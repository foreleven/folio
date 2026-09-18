import { Clock, Context, Effect, Layer, Schema, Semaphore } from 'effect'
import { resolve } from 'node:path'
import { IntegrationContext, IntegrationError } from '../base/index.ts'
import {
  AuthorizationRejected, LarkService, larkScopes
} from './service.ts'
import type { AuthorizationRequest, LarkServiceApi, RegistrationProgress } from './service.ts'
import { LarkApp, readPrivateState, updatePrivateState } from './state.ts'
import type { UserAuth } from './state.ts'

export { AuthorizationRejected, larkScopes } from './service.ts'

/** Optional host credentials; omitted values reuse the existing private application state. */
export const LarkApplication = Context.Reference<LarkApp | undefined>('@folio/integrations/lark/LarkApplication', {
  defaultValue: () => undefined
})

type Session = { readonly lock: Semaphore.Semaphore; rejected?: 'app' | 'user'; failures: number }
const sessions = new Map<string, Session>()

export type LarkAuthPhase =
  | 'app_missing'
  | 'app_rejected'
  | 'app_recovering'
  | 'user_missing'
  | 'user_rejected'
  | 'user_recovering'
  | 'ready'

export interface LarkAuthSnapshot {
  readonly installed: boolean
  readonly phase: LarkAuthPhase
}

function snapshot(installed: boolean, phase: LarkAuthPhase): LarkAuthSnapshot {
  return { installed, phase }
}

/** Saved credentials are usable only for this app/brand and the full requested resource scope. */
export function belongsToApp(saved: { clientId: string; brand: string } | undefined, app: LarkApp): boolean {
  return saved?.clientId === app.clientId && saved.brand === app.brand
}

/** Scope changes require a new user grant; refreshing cannot manufacture missing permissions. */
export function hasPermissions(saved: UserAuth | undefined): boolean {
  return !!saved?.scope && larkScopes.every((scope) => saved.scope!.split(/\s+/).includes(scope))
}

export const releaseSession = Effect.gen(function*() {
  const { directory } = yield* IntegrationContext
  sessions.delete(resolve(directory))
})

function make(service: LarkServiceApi) {
  /** Only runtime coordination lives in memory; credentials and verification survive restarts. */
  const session = Effect.fn('LarkAuth.session')(function*() {
    const { directory } = yield* IntegrationContext
    const key = resolve(directory)
    return yield* Effect.sync(() => {
      let current = sessions.get(key)
      if (!current) {
        current = { lock: Semaphore.makeUnsafe(1), failures: 0 }
        sessions.set(key, current)
      }
      return current
    })
  })

  const exclusive = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.flatMap(session(), (current) => current.lock.withPermit(effect))

  /** Resolves a supplied or persisted application without creating or changing it. */
  const getApp = Effect.fn('LarkAuth.getApp')(function*() {
    const { directory } = yield* IntegrationContext
    const supplied = yield* LarkApplication
    return supplied === undefined ? (yield* readPrivateState(directory)).app
      : yield* Schema.decodeUnknownEffect(LarkApp)(supplied)
  })

  /** Maps durable authentication facts into a provider-domain phase, without UI concerns. */
  const inspect = Effect.fn('LarkAuth.inspect')(function*() {
    const { directory } = yield* IntegrationContext
    const privateState = yield* readPrivateState(directory)
    const app = yield* getApp()
    if (!app) return snapshot(privateState.installed, 'app_missing')
    const current = yield* session()
    const now = yield* Clock.currentTimeMillis
    const appAuth = privateState.appAuth
    if (current.rejected === 'app') return snapshot(privateState.installed, 'app_rejected')
    if (!appAuth || !belongsToApp(appAuth, app) || appAuth.expiresAt <= now) {
      return snapshot(privateState.installed, 'app_recovering')
    }
    const saved = privateState.userAuth
    if (!saved || !belongsToApp(saved, app) || !hasPermissions(saved)) {
      return snapshot(privateState.installed, 'user_missing')
    }
    if (saved.expiresAt > now && saved.verified !== false) {
      return snapshot(privateState.installed, 'ready')
    }
    if (current.rejected === 'user') return snapshot(privateState.installed, 'user_rejected')
    if (saved.expiresAt <= now && (!saved.refreshToken || (saved.refreshExpiresAt && saved.refreshExpiresAt <= now))) {
      return snapshot(privateState.installed, 'user_missing')
    }
    return snapshot(privateState.installed, 'user_recovering')
  })

  /** Refreshes local app/user credentials without initiating browser authorization. Caller owns the installation lock. */
  const maintainUnlocked = Effect.fn('LarkAuth.maintainUnlocked')(function*() {
    const { directory } = yield* IntegrationContext
    const current = yield* session()
    const app = yield* getApp()
    if (!app || current.rejected) return
    const now = yield* Clock.currentTimeMillis
    let privateState = yield* readPrivateState(directory)
    const appAuth = privateState.appAuth
    if (!appAuth || !belongsToApp(appAuth, app) || appAuth.expiresAt <= now + 60_000) {
      privateState = yield* updatePrivateState(directory, { appAuth: yield* service.authorizeApp(app) })
    }
    let saved = privateState.userAuth
    if (!saved || !belongsToApp(saved, app) || !hasPermissions(saved)) return
    if (saved.expiresAt <= now + 60_000 && saved.refreshToken &&
        (!saved.refreshExpiresAt || saved.refreshExpiresAt > now)) {
      saved = { ...yield* service.refreshUser(app, saved), verified: false }
      // A rotated refresh token can invalidate the old pair, so persist before remote verification.
      yield* updatePrivateState(directory, { userAuth: saved })
    }
    if (saved.expiresAt <= now) return
    const identity = yield* service.userIdentity(app, saved.accessToken)
    if (identity !== saved.openId) {
      yield* updatePrivateState(directory, { userAuth: { ...saved, verified: false } })
      return yield* new AuthorizationRejected({ target: 'user' })
    }
    if (saved.verified === false) yield* updatePrivateState(directory, { userAuth: { ...saved, verified: true } })
  })

  /** Records only retry/rejection categories; no credential-bearing transport detail is retained. */
  const recoverUnlocked = maintainUnlocked().pipe(
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
    }))
  )
  const recover = exclusive(recoverUnlocked)
  /** Publishes refreshed facts before releasing the installation lock; unavailable facts publish undefined. */
  const reconcile = (publish: (snapshot: LarkAuthSnapshot | undefined) => Effect.Effect<void, IntegrationError>) => exclusive(
    recoverUnlocked.pipe(
      Effect.andThen(inspect()),
      Effect.catch(() => Effect.succeed(undefined)),
      Effect.flatMap(publish)
    )
  )

  /**
   * Verify Folio's externally supplied token directly. CLI auth status describes its
   * global login and is unsupported in external-credentials mode; it cannot supply
   * identity or expiry metadata for this installation.
   */
  const check = Effect.fn('LarkAuth.check')(function*() {
    yield* Effect.gen(function*() {
      yield* maintainUnlocked()
      const status = yield* inspect()
      if (status.phase !== 'ready') return yield* new IntegrationError({ message: `Lark authentication is not ready (${status.phase}).` })
      const current = yield* session()
      current.failures = 0
    }).pipe(exclusive)
  }, Effect.annotateLogs({ integration: 'lark', subsystem: 'auth' }), Effect.withLogSpan('lark.auth.check'))

  /** Creates/reuses an app and completes authorization while keeping every state mutation under one lock. */
  const connect = Effect.fn('LarkAuth.connect')(function*(callbacks: {
    readonly onAppProgress: (progress: RegistrationProgress) => Effect.Effect<void, IntegrationError>
    readonly onAppReady: () => Effect.Effect<void, IntegrationError>
    readonly onUserRequired: () => Effect.Effect<void, IntegrationError>
    readonly onUserAuthorize: (request: AuthorizationRequest) => Effect.Effect<void, IntegrationError>
  }) {
    const { directory } = yield* IntegrationContext
    yield* Effect.gen(function*() {
      const current = yield* session()
      current.rejected = undefined
      let app = yield* getApp()
      if (!app) app = yield* service.createApp(callbacks.onAppProgress)
      yield* updatePrivateState(directory, { app })
      yield* callbacks.onAppReady()
      yield* recoverUnlocked
      const snapshot = yield* inspect()
      if (snapshot.phase === 'ready') return
      if (snapshot.phase !== 'user_missing' && snapshot.phase !== 'user_rejected') {
        return yield* new IntegrationError({ message: 'Lark is unable to connect. Please try again.' })
      }
      yield* callbacks.onUserRequired()
      const auth = yield* service.authorizeUser(app, callbacks.onUserAuthorize)
      yield* updatePrivateState(directory, { userAuth: auth })
      current.rejected = undefined
      current.failures = 0
    }).pipe(exclusive)
  })

  /** Chooses the renewal deadline/backoff from locally persisted expiry metadata. */
  const nextMaintenance = Effect.fn('LarkAuth.nextMaintenance')(function*() {
    const { directory } = yield* IntegrationContext
    const current = yield* session()
    const now = yield* Clock.currentTimeMillis
    const privateState = yield* readPrivateState(directory)
    const app = privateState.appAuth
    const user = privateState.userAuth
    if (current.failures) {
      const expiresIn = Math.min(app?.expiresAt ?? Infinity, user?.expiresAt ?? Infinity) - now
      return Math.max(1000, Math.min(30_000 * 2 ** Math.min(current.failures - 1, 3), expiresIn > 0 ? expiresIn : Infinity))
    }
    const due = Math.min(app?.expiresAt ?? Infinity, user?.expiresAt ?? Infinity) - now - 60_000
    return due > 0 ? Math.min(due, 60_000) : 30_000
  })

  const release = Effect.fn('LarkAuth.release')(function*() {
    const { directory } = yield* IntegrationContext
    sessions.delete(resolve(directory))
  })

  return { exclusive, inspect, check, recover, reconcile, connect, nextMaintenance, release }
}

export type LarkAuthApi = ReturnType<typeof make>

/** Local authentication boundary: state, serialization, check/refresh policy, and durable token lifecycle. */
export class LarkAuth extends Context.Service<LarkAuth, LarkAuthApi>()('@folio/integrations/lark/LarkAuth') {
  static readonly layer = Layer.effect(LarkAuth, Effect.map(LarkService, make)).pipe(Layer.provide(LarkService.layer))
}
