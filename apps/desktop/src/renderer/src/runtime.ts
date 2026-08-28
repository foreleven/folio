import { Layer } from 'effect'
import * as Atom from 'effect/unstable/reactivity/Atom'
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

/** RPC-backed atom function for the user-triggered system metadata check. */
export const checkSystemInfoAtom = RendererAtomRuntime.fn<void>()(
  () => SystemRpcClient.use((client) => client['system.getInfo']())
)
