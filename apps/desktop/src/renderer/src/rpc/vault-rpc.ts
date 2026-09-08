import { AtomRpc } from 'effect/unstable/reactivity'
import { OpenExistingVault, OpenVault, VaultRpcs } from '../../../shared/rpc/vault-rpc'
import { ElectronRpcProtocolLive } from './electron-rpc-protocol'

/** Uses the same isolated transport as preferences, with per-window query state. */
export class VaultRpcClient extends AtomRpc.Service<VaultRpcClient>()(
  'folio/renderer/VaultRpcClient',
  { group: VaultRpcs, protocol: ElectronRpcProtocolLive }
) {
  static readonly open = VaultRpcClient.mutation(OpenVault._tag)
  static readonly openExisting = VaultRpcClient.mutation(OpenExistingVault._tag)
}
