import { Effect, Layer, ManagedRuntime } from 'effect'
import { RpcSerialization, RpcServer } from 'effect/unstable/rpc'
import { SystemRpcs } from '../../shared/rpc/system-rpc'
import { SystemService } from '../services/system-service'
import { ElectronRpcServerProtocolLive } from './electron-rpc-protocol'
import { SystemRpcHandlersLive } from './system-rpc'

const SystemHandlersLive = SystemRpcHandlersLive.pipe(
  Layer.provide(SystemService.layer)
)

const ElectronRpcProtocolLive = ElectronRpcServerProtocolLive.pipe(
  Layer.provide(RpcSerialization.layerJson)
)

const RpcDependenciesLive = Layer.merge(
  SystemHandlersLive,
  ElectronRpcProtocolLive
)

/** Complete main-process Effect RPC server Layer. */
export const MainRpcLive = RpcServer.layer(SystemRpcs).pipe(
  Layer.provide(RpcDependenciesLive)
)

export type MainRpcRuntime = ManagedRuntime.ManagedRuntime<never, never>

/** Creates the scoped runtime that owns the main-process RPC server fiber. */
export function createMainRpcRuntime(): MainRpcRuntime {
  return ManagedRuntime.make(MainRpcLive)
}

/** Forces lazy Layer construction so Electron IPC begins accepting requests. */
export function startMainRpcRuntime(runtime: MainRpcRuntime): Promise<void> {
  return runtime.runPromise(Effect.void)
}
