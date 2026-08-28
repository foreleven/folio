import { Effect, Stream } from 'effect'
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

/** Writable signal used by the UI to enqueue a runtime check request. */
export const checkRequestAtom = Atom.make(0)

const checkRequests = Atom.toStream(checkRequestAtom).pipe(
  Stream.filter((requestId) => requestId > 0)
)

/**
 * Long-lived action processor. The state atom stays a plain value while this
 * scoped Effect atom owns the RPC dependency and stream cancellation.
 */
export const checkRuntimeStreamAtom = RendererAtomRuntime.atom(
  Stream.runForEach(checkRequests, () =>
    Effect.gen(function*() {
      const registry = yield* AtomRegistry.AtomRegistry
      registry.set(runtimeStateAtom, { _tag: 'Checking' })

      const info = yield* SystemRpcClient.getInfo
      registry.set(runtimeStateAtom, {
        _tag: 'Available',
        platform: info.platform,
        version: info.version
      })
    }).pipe(
      Effect.catchCause(() =>
        Effect.gen(function*() {
          const registry = yield* AtomRegistry.AtomRegistry
          registry.set(runtimeStateAtom, { _tag: 'Unavailable' })
        })
      )
    )
  )
)
