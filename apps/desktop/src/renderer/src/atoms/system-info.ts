import { Duration, Effect, Stream } from 'effect'
import * as Atom from 'effect/unstable/reactivity/Atom'
import * as AtomRegistry from 'effect/unstable/reactivity/AtomRegistry'
import { SystemRpcClient } from '../../../shared/rpc/system-rpc'
import { RendererAtomRuntime } from '../runtime'

/** Explicit renderer state; effects update this value through the registry. */
export type RuntimeState =
  | { readonly _tag: 'NotChecked' }
  | { readonly _tag: 'Checking' }
  | { readonly _tag: 'Available'; readonly platform: string; readonly version: string }
  | { readonly _tag: 'Unavailable' }

/** Value atom intentionally independent from RPC and service implementations. */
export const runtimeStateAtom = Atom.make<RuntimeState>({ _tag: 'NotChecked' })

/** Monotonic click signal consumed by the optional throttled entrypoint. */
export const checkRuntimeRequestAtom = Atom.make(0)

const runCheckRuntime = (registry: AtomRegistry.AtomRegistry) => Effect.gen(function*() {
  registry.set(runtimeStateAtom, { _tag: 'Checking' })

  const info = yield* SystemRpcClient.getInfo.pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => registry.set(runtimeStateAtom, { _tag: 'Unavailable' })).pipe(
        Effect.flatMap(() => Effect.failCause(cause))
      )
    )
  )

  registry.set(runtimeStateAtom, {
    _tag: 'Available',
    platform: info.platform,
    version: info.version
  })

  return info
})

/**
 * Async action atom for checking runtime metadata.
 *
 * The state atom remains a plain writable value. `Atom.fn` owns one invocation
 * at a time by default, and the renderer decides when to trigger it through
 * `useAtomSet`; no long-lived stream is needed for this one-shot action.
 */
export const checkRuntimeAtom = RendererAtomRuntime.fn(
  (_request: void, get: Atom.FnContext) => runCheckRuntime(get.registry).pipe(
    // Keep the value atom coherent if Atom.fn interrupts a running request.
    Effect.ensuring(
      Effect.sync(() => {
        if (get.registry.get(runtimeStateAtom)._tag === 'Checking') {
          // FnContext writes are scoped to the action and may already be closed.
          get.registry.set(runtimeStateAtom, { _tag: 'Unavailable' })
        }
      })
    )
  )
)

const checkRuntimeRequests = Atom.toStream(checkRuntimeRequestAtom).pipe(
  Stream.filter((requestId) => requestId > 0),
  // Throttle individual clicks even when Atom batches synchronous writes.
  Stream.rechunk(1),
  Stream.throttle({
    cost: (clicks) => clicks.length,
    units: 1,
    duration: Duration.seconds(1),
    strategy: 'enforce'
  })
)

/**
 * Optional throttled click entrypoint: at most one RPC starts per second and
 * additional clicks in that window are discarded by the stream policy.
 */
export const checkRuntimeThrottleAtom = RendererAtomRuntime.atom(
  Stream.runForEach(checkRuntimeRequests, () =>
    Effect.gen(function*() {
      const registry = yield* AtomRegistry.AtomRegistry
      registry.set(checkRuntimeAtom, undefined)
    })
  )
)
