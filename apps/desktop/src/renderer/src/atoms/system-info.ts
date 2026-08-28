import { Duration, Effect, Queue, Stream } from 'effect'
import * as Atom from 'effect/unstable/reactivity/Atom'
import * as AtomRegistry from 'effect/unstable/reactivity/AtomRegistry'
import { SystemRpcClient } from '../../../shared/rpc/system-rpc'
import { RendererAtomRuntime } from '../runtime'

/** Explicit renderer state; effects update this value through the registry. */
export type SystemInfoState =
  | { readonly _tag: 'NotChecked' }
  | { readonly _tag: 'Checking' }
  | { readonly _tag: 'Available'; readonly platform: string; readonly version: string }
  | { readonly _tag: 'Unavailable' }

/** Value atom intentionally independent from RPC and service implementations. */
export const systemInfoStateAtom = Atom.make<SystemInfoState>({ _tag: 'NotChecked' })

/** Loads system metadata and settles the UI state on failure or interruption. */
const loadSystemInfo = (registry: AtomRegistry.AtomRegistry) =>
  Effect.gen(function*() {
    registry.set(systemInfoStateAtom, { _tag: 'Checking' })

    const info = yield* SystemRpcClient.getInfo.pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => registry.set(systemInfoStateAtom, { _tag: 'Unavailable' })).pipe(
          Effect.flatMap(() => Effect.failCause(cause))
        )
      )
    )

    registry.set(systemInfoStateAtom, {
      _tag: 'Available',
      platform: info.platform,
      version: info.version
    })

    return info
  }).pipe(
    // A canceled request must not leave the independent value atom waiting.
    Effect.ensuring(
      Effect.sync(() => {
        if (registry.get(systemInfoStateAtom)._tag === 'Checking') {
          registry.set(systemInfoStateAtom, { _tag: 'Unavailable' })
        }
      })
    )
  )

/**
 * Runs the renderer-wide click consumer until its owning atom scope closes.
 * Each queue event is throttled to one RPC per second; failures are converted
 * to completed iterations so one failed RPC cannot terminate the consumer.
 */
const systemInfoRequestStream = (events: Queue.Queue<void>, registry: AtomRegistry.AtomRegistry) =>
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
      loadSystemInfo(registry).pipe(
        // A failed request updates systemInfoStateAtom but must not stop the click consumer.
        Effect.catchCause(() => Effect.void)
      )
    )
  )

/**
 * Internal event queue and long-lived throttle consumer for system-info requests.
 * `keepAlive` lets the request atom own this consumer without a second public
 * atom or an explicit mount in the React tree.
 */
const systemInfoRequestQueueAtom = Atom.keepAlive(
  RendererAtomRuntime.atom(
    Effect.acquireRelease(
      Effect.gen(function*() {
        const events = yield* Queue.unbounded<void>()
        const registry = yield* AtomRegistry.AtomRegistry
        yield* systemInfoRequestStream(events, registry).pipe(Effect.forkScoped)
        return events
      }),
      (events) => Queue.shutdown(events)
    )
  )
)

/** Event action used by UI callbacks to enqueue a system-info request. */
export const requestSystemInfoAtom = RendererAtomRuntime.fn(
  (_request: void, get: Atom.FnContext) =>
    get.result(systemInfoRequestQueueAtom).pipe(
      Effect.flatMap((events) => Queue.offer(events, undefined)),
      Effect.asVoid
    )
)

/**
 * Async action atom for loading system metadata without throttling.
 *
 * The state atom remains a plain writable value. `Atom.fn` owns one invocation
 * at a time by default; callers can trigger this action directly with
 * `useAtomSet` when bypassing the queued click entrypoint.
 */
export const loadSystemInfoAtom = RendererAtomRuntime.fn(
  (_request: void, get: Atom.FnContext) => loadSystemInfo(get.registry)
)
