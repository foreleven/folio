import { Effect, Stream } from 'effect'
import { AtomRpc } from 'effect/unstable/reactivity'
import { IntegrationRpcs } from '../../../shared/rpc/integration-rpc'
import { ElectronRpcProtocolLive } from './electron-rpc-protocol'

/** All settings windows consume main-process committed snapshots over the existing transport. */
export class IntegrationRpcClient extends AtomRpc.Service<IntegrationRpcClient>()(
  'folio/renderer/IntegrationRpcClient', { group: IntegrationRpcs, protocol: ElectronRpcProtocolLive }
) {
  static readonly install = IntegrationRpcClient.mutation('integrations.install')
  static readonly inspect = IntegrationRpcClient.mutation('integrations.inspect')
  static readonly action = IntegrationRpcClient.mutation('integrations.action')

  static readonly integrations = IntegrationRpcClient.runtime.atom(Stream.unwrap(
    Effect.map(IntegrationRpcClient, (client) => client('integrations.watch', undefined))
  ))
}
