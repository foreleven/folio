import { Effect } from 'effect'
import * as Atom from 'effect/unstable/reactivity/Atom'
import * as AtomRegistry from 'effect/unstable/reactivity/AtomRegistry'
import { SystemRpcClient } from '../rpc/system-rpc'
import { makeThrottledAction } from './throttle'

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

/** Event action used by UI callbacks to request system metadata. */
export const requestSystemInfoAtom = makeThrottledAction(
  SystemRpcClient.runtime,
  (_value: void, registry) => loadSystemInfo(registry),
  { duration: '1 second' }
)
