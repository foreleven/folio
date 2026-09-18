import { AtomRpc } from 'effect/unstable/reactivity'
import { GetSystemInfo, SystemRpcs } from '../../../shared/rpc/system-rpc'
import { ElectronRpcProtocolLive } from './electron-rpc-protocol'

/** Renderer-owned AtomRpc client backed by the Electron bridge protocol. */
export class SystemRpcClient extends AtomRpc.Service<SystemRpcClient>()(
  'folio/renderer/SystemRpcClient',
  {
    group: SystemRpcs,
    protocol: ElectronRpcProtocolLive
  }
) {
  static readonly getSystemInfo = SystemRpcClient.query(GetSystemInfo._tag, void 0, {})
}
