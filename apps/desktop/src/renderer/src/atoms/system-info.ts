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

const runtimeCheckStream = (events: Queue.Queue<void>, registry: AtomRegistry.AtomRegistry) =>
  Stream.fromQueue(events).pipe(
    // Throttle individual clicks even when Queue emits a batch.
    Stream.rechunk(1),
    Stream.throttle({
      cost: (clicks) => clicks.length,
      units: 1,
      duration: Duration.seconds(1),
      strategy: 'enforce'
    }),
    Stream.runForEach(() =>
      runCheckRuntimeAction(registry).pipe(
        // A failed request updates runtimeStateAtom but must not stop the click consumer.
        Effect.catchCause(() => Effect.void)
      )
    )
  )

/**
 * Internal event queue and long-lived throttle consumer for runtime checks.
 * `keepAlive` lets the request atom own this consumer without a second public
 * atom or an explicit mount in the React tree.
 */
const checkRuntimeEventsAtom = Atom.keepAlive(
  RendererAtomRuntime.atom(
    Effect.acquireRelease(
      Effect.gen(function*() {
        const events = yield* Queue.unbounded<void>()
        const registry = yield* AtomRegistry.AtomRegistry
        yield* runtimeCheckStream(events, registry).pipe(Effect.forkScoped)
        return events
      }),
      (events) => Queue.shutdown(events)
    )
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

/**
 * Async action atom for checking runtime metadata.
 *
 * The state atom remains a plain writable value. `Atom.fn` owns one invocation
 * at a time by default; callers can trigger this action directly with
 * `useAtomSet` when bypassing the queued click entrypoint.
 */
export const checkRuntimeAtom = RendererAtomRuntime.fn(
  (_request: void, get: Atom.FnContext) => runCheckRuntimeAction(get.registry)
)
