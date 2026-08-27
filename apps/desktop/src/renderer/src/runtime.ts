import { Layer, ManagedRuntime } from 'effect'
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

export type RendererRuntime = ManagedRuntime.ManagedRuntime<SystemRpcClient, never>

/** Creates the scoped Effect runtime owned by one renderer application. */
export function createRendererRuntime(): RendererRuntime {
  return ManagedRuntime.make(RendererLive)
}
