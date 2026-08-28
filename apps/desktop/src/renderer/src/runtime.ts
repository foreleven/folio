import { Effect, Layer, Stream } from 'effect'
import * as Atom from 'effect/unstable/reactivity/Atom'
import * as AtomRegistry from 'effect/unstable/reactivity/AtomRegistry'
import { RpcSerialization } from 'effect/unstable/rpc'
import { SystemRpcClient } from '../../shared/rpc/system-rpc'
import {
  ElectronRpcBridgeService,
  ElectronRpcClientProtocolLive
} from './rpc/electron-rpc-protocol'

const ElectronRpcProtocolLive = ElectronRpcClientProtocolLive.pipe(
  Layer.provide(ElectronRpcBridgeService.layer),
  Layer.provide(RpcSerialization.layerJson)
)

/** Complete renderer Layer with the generated Effect RPC client. */
export const RendererLive = SystemRpcClient.layer.pipe(
  Layer.provide(ElectronRpcProtocolLive)
)

/**
 * Registry-scoped Effect runtime used by renderer atoms. Atom owns the scope
 * per React registry, so RPC fibers and the Electron listener are cleaned up
 * when the registry is disposed instead of requiring a second React context.
 */
export const RendererAtomRuntime = Atom.runtime(RendererLive)

/** Explicit renderer state; effects update this value through the registry. */
export type RuntimeState =
  | { readonly _tag: 'NotChecked' }
  | { readonly _tag: 'Checking' }
  | { readonly _tag: 'Available'; readonly platform: string; readonly version: string }
  | { readonly _tag: 'Unavailable' }

export const runtimeStateAtom = Atom.make<RuntimeState>({ _tag: 'NotChecked' })

/** Writable signal used by the UI to enqueue a runtime check request. */
export const checkRequestAtom = Atom.make(0)

const checkRequests = Atom.toStream(checkRequestAtom).pipe(
  Stream.filter((requestId) => requestId > 0)
)

/**
 * Long-lived click processor. Keeping this separate from `runtimeStateAtom`
 * makes the state atom a plain value/setter and keeps RPC orchestration in a
 * cancellable stream owned by the current Atom registry.
 */
export const checkRuntimeStreamAtom = RendererAtomRuntime.atom(
  Stream.runForEach(checkRequests, () =>
    Effect.gen(function*() {
      const registry = yield* AtomRegistry.AtomRegistry
      registry.set(runtimeStateAtom, { _tag: 'Checking' })

      const info = yield* SystemRpcClient.use((client) => client['system.getInfo']())
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
