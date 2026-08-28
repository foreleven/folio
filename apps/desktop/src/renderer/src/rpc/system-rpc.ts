import { Layer } from 'effect'
import { AtomRpc } from 'effect/unstable/reactivity'
import { RpcSerialization } from 'effect/unstable/rpc'
import { GetSystemInfo, SystemRpcs } from '../../../shared/rpc/system-rpc'
import {
  ElectronRpcBridgeService,
  ElectronRpcClientProtocolLive
} from './electron-rpc-protocol'

const SystemRpcProtocolLive = ElectronRpcClientProtocolLive.pipe(
  Layer.provide(ElectronRpcBridgeService.layer),
  Layer.provide(RpcSerialization.layerJson)
)

/** Renderer-owned AtomRpc client backed by the Electron bridge protocol. */
export class SystemRpcClient extends AtomRpc.Service<SystemRpcClient>()(
  'folio/renderer/SystemRpcClient',
  {
    group: SystemRpcs,
    protocol: SystemRpcProtocolLive
  }
) {
  /** Retrieves system metadata without exposing the RPC tag to atom logic. */
  static readonly getInfo = SystemRpcClient.use((client) =>
    client(GetSystemInfo._tag, undefined)
  )
}
