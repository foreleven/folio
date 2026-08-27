import { Layer } from 'effect'
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
