import { IntegrationRpcs } from '../../shared/rpc/integration-rpc'
import { IntegrationRpcHandlersLive } from './integration-rpc'
import { ModelRpcs } from '../../shared/rpc/model-rpc'
import { ModelRpcHandlersLive } from './model-rpc'
import { VaultRpcs } from '../../shared/rpc/vault-rpc'
import { VaultRpcHandlersLive } from './vault-rpc'
import { Layer } from 'effect'
import { RpcSerialization, RpcServer } from 'effect/unstable/rpc'
import { SystemRpcs } from '../../shared/rpc/system-rpc'
import { ConfigRpcs } from '../../shared/rpc/config-rpc'
import { ConfigRpcHandlersLive } from './config-rpc'
import { SystemService } from '../services/system-service'
import { ElectronRpcServerProtocolLive } from './electron-rpc-protocol'
import { SystemRpcHandlersLive } from './system-rpc'

const SystemHandlersLive = SystemRpcHandlersLive.pipe(
  Layer.provide(SystemService.layer)
)

const ElectronRpcProtocolLive = ElectronRpcServerProtocolLive.pipe(
  Layer.provide(RpcSerialization.layerJson)
)

const RpcDependenciesLive = Layer.mergeAll(
  SystemHandlersLive,
  ConfigRpcHandlersLive,
  ModelRpcHandlersLive,
  IntegrationRpcHandlersLive,
  VaultRpcHandlersLive,
  ElectronRpcProtocolLive
)

/** Complete main-process Effect RPC server Layer. */
export const MainRpcLive = RpcServer.layer(SystemRpcs.merge(ConfigRpcs, ModelRpcs, VaultRpcs, IntegrationRpcs)).pipe(
  Layer.provide(RpcDependenciesLive)
)
