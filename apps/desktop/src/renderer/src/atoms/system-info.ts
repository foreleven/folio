import { Duration, Effect, Queue, Stream } from 'effect'
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

const checkRuntimeEventsAtom = RendererAtomRuntime.atom(
  Effect.acquireRelease(
    Queue.unbounded<void>(),
    (events) => Queue.shutdown(events)
  )
)

/** Event action used by UI callbacks to enqueue a runtime check. */
export const requestRuntimeCheckAtom = RendererAtomRuntime.fn(
  (_request: void, get: Atom.FnContext) =>
    get.result(checkRuntimeEventsAtom).pipe(
      Effect.flatMap((events) => Queue.offer(events, undefined)),
      Effect.asVoid
    )
)

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

const runCheckRuntimeAction = (registry: AtomRegistry.AtomRegistry) =>
  runCheckRuntime(registry).pipe(
    // A canceled request must not leave the independent value atom waiting.
    Effect.ensuring(
      Effect.sync(() => {
        if (registry.get(runtimeStateAtom)._tag === 'Checking') {
          registry.set(runtimeStateAtom, { _tag: 'Unavailable' })
        }
      })
    )
  )

/**
 * Async action atom for checking runtime metadata.
 *
 * The state atom remains a plain writable value. `Atom.fn` owns one invocation
 * at a time by default; callers can trigger this action directly with
 * `useAtomSet` or use the throttled click entrypoint below.
 */
export const checkRuntimeAtom = RendererAtomRuntime.fn(
  (_request: void, get: Atom.FnContext) => runCheckRuntimeAction(get.registry)
)

const checkRuntimeRequests = (get: Atom.AtomContext) =>
  Stream.unwrap(
    get.result(checkRuntimeEventsAtom).pipe(Effect.map(Stream.fromQueue))
  ).pipe(
    // Throttle individual clicks even when Queue emits a batch.
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
  (get) =>
    Stream.runForEach(checkRuntimeRequests(get), () =>
      Effect.gen(function*() {
        const registry = yield* AtomRegistry.AtomRegistry
        yield* runCheckRuntimeAction(registry).pipe(
          // A failed request updates runtimeStateAtom but must not stop the click consumer.
          Effect.catchCause(() => Effect.void)
        )
      })
    )
)
