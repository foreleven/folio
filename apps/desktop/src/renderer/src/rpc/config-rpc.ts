import { Effect, Stream } from 'effect'
import { AtomRpc } from 'effect/unstable/reactivity'
import { ConfigRpcs, UpdateConfig, WatchConfig } from '../../../shared/rpc/config-rpc'
import { ElectronRpcProtocolLive } from './electron-rpc-protocol'

/** Shares the existing Electron transport while exposing configuration-specific atoms. */
export class ConfigRpcClient extends AtomRpc.Service<ConfigRpcClient>()(
  'folio/renderer/ConfigRpcClient',
  { group: ConfigRpcs, protocol: ElectronRpcProtocolLive }
) {
  static readonly update = ConfigRpcClient.mutation(UpdateConfig._tag)

  /** Continuously consumes updates and retains only the latest snapshot; query uses manual pulls. */
  static readonly watch = ConfigRpcClient.runtime.atom(Stream.unwrap(
    Effect.map(ConfigRpcClient, (client) => client(WatchConfig._tag, undefined))
  ))
}
