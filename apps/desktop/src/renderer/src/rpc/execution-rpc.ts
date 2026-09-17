import { AtomRpc } from 'effect/unstable/reactivity'
import { ExecutionRpcs } from '../../../shared/rpc/execution-rpc'
import { ElectronRpcProtocolLive } from './electron-rpc-protocol'

export class ExecutionRpcClient extends AtomRpc.Service<ExecutionRpcClient>()(
  'folio/renderer/ExecutionRpcClient', { group: ExecutionRpcs, protocol: ElectronRpcProtocolLive }
) {
  static readonly status = ExecutionRpcClient.query('executions.status', undefined)
}
