import { Duration, Effect, Queue, Stream } from 'effect'
import * as Atom from 'effect/unstable/reactivity/Atom'
import * as AtomRegistry from 'effect/unstable/reactivity/AtomRegistry'

export interface ThrottleOptions {
  /** Minimum interval between admitted events. */
  readonly duration: Duration.Input
  /** Number of events allowed per interval; defaults to one. */
  readonly units?: number
}

/**
 * Creates a writable action atom backed by a throttled event stream.
 * The stream is kept alive after the first write and is released with the
 * registry, so callers only need the returned atom's setter.
 */
export const makeThrottledAction = <R, A, B, E>(
  runtime: Atom.AtomRuntime<R>,
  run: (value: A, registry: AtomRegistry.AtomRegistry) => Effect.Effect<B, E, R>,
  options: ThrottleOptions
): Atom.AtomResultFn<A, void, E> => {
  const eventsAtom = runtime.atom(
      Effect.acquireRelease(
        Effect.gen(function*() {
          const events = yield* Queue.unbounded<A>()
          const registry = yield* AtomRegistry.AtomRegistry
          yield* Stream.fromQueue(events).pipe(
            Stream.rechunk(1),
            Stream.throttle({
              cost: (values) => values.length,
              units: options.units ?? 1,
              duration: options.duration,
              strategy: 'enforce'
            }),
            Stream.runForEach((value) =>
              run(value, registry).pipe(Effect.catchCause(() => Effect.void))
            ),
            Effect.forkScoped
          )
          return events
        }),
        (events) => Queue.shutdown(events)
      )
    )


  return runtime.fn(
    (_value: A, get: Atom.FnContext) =>
      get.result(eventsAtom).pipe(
        Effect.flatMap((events) => Queue.offer(events, _value)),
        Effect.asVoid
      )
  )
}

/** Creates a throttled writable action that refreshes any readable atom. */
export const makeThrottledRefresh = <R, A>(
  runtime: Atom.AtomRuntime<R>,
  atom: Atom.Atom<A>,
  options: ThrottleOptions
) =>
  makeThrottledAction(
    runtime,
    (_value: void, registry) => Effect.sync(() => registry.refresh(atom)),
    options
  )
