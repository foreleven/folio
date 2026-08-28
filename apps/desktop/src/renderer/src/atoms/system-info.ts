import { Effect } from 'effect'
import * as Atom from 'effect/unstable/reactivity/Atom'
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

/**
 * Async action atom for checking runtime metadata.
 *
 * The state atom remains a plain writable value. `Atom.fn` owns one invocation
 * at a time by default, and the renderer decides when to trigger it through
 * `useAtomSet`; no long-lived stream is needed for this one-shot action.
 */
export const checkRuntimeAtom = RendererAtomRuntime.fn(
  (_request: void, get: Atom.FnContext) => Effect.gen(function*() {
    get.set(runtimeStateAtom, { _tag: 'Checking' })

    const info = yield* SystemRpcClient.getInfo.pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => get.set(runtimeStateAtom, { _tag: 'Unavailable' })).pipe(
          Effect.flatMap(() => Effect.failCause(cause))
        )
      )
    )

    get.set(runtimeStateAtom, {
      _tag: 'Available',
      platform: info.platform,
      version: info.version
    })

    return info
  })
)
