import { Effect, Stream } from 'effect'
import { AtomRpc } from 'effect/unstable/reactivity'
import { ConfigRpcs, UpdateConfig } from '../../../shared/rpc/config-rpc'
import { ElectronRpcProtocolLive } from './electron-rpc-protocol'

/** Shares the existing Electron transport while exposing configuration-specific atoms. */
export class ConfigRpcClient extends AtomRpc.Service<ConfigRpcClient>()(
  'folio/renderer/ConfigRpcClient',
  { group: ConfigRpcs, protocol: ElectronRpcProtocolLive }
) {
  static readonly update = ConfigRpcClient.mutation(UpdateConfig._tag)
}

/** Push-based atom retains only the latest config; it does not accumulate stream history. */
export const configAtom = ConfigRpcClient.runtime.atom(Stream.unwrap(
  Effect.map(ConfigRpcClient, (client) => client('config.watch', undefined))
))
