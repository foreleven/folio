import { ExecutionRpcs } from '../../shared/rpc/execution-rpc'
import { ExecutionRpcHandlersLive } from './execution-rpc'
import { VaultMiddlewareLive } from './vault-middleware'
import { IntegrationRpcs } from '../../shared/rpc/integration-rpc'
import { TaskRpcs } from '../../shared/rpc/task-rpc'
import { TaskRpcHandlersLive } from './task-rpc'
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

const SystemHandlersLive = SystemRpcHandlersLive.pipe(Layer.provide(SystemService.layer))

const ElectronRpcProtocolLive = ElectronRpcServerProtocolLive.pipe(Layer.provide(RpcSerialization.layerJson))

const RpcDependenciesLive = Layer.mergeAll(
  SystemHandlersLive,
  ExecutionRpcHandlersLive,
  ConfigRpcHandlersLive,
  ModelRpcHandlersLive,
  IntegrationRpcHandlersLive,
  VaultRpcHandlersLive,
  TaskRpcHandlersLive,
  ElectronRpcProtocolLive
)

/** Complete main-process Effect RPC server Layer. */
export const MainRpcLive = RpcServer.layer(SystemRpcs.merge(ExecutionRpcs, ConfigRpcs, ModelRpcs, VaultRpcs, IntegrationRpcs, TaskRpcs)).pipe(
  Layer.provide(RpcDependenciesLive),
  Layer.provide(VaultMiddlewareLive)
)
