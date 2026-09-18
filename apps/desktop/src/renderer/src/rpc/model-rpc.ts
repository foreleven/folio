import { Effect, Stream } from 'effect'
import { AtomRpc } from 'effect/unstable/reactivity'
import { ModelRpcs, RefreshModelCatalog } from '../../../shared/rpc/model-rpc'
import { ElectronRpcProtocolLive } from './electron-rpc-protocol'

/** Exposes credential-blind model snapshots and explicit model mutations to settings views. */
export class ModelRpcClient extends AtomRpc.Service<ModelRpcClient>()(
  'folio/renderer/ModelRpcClient',
  { group: ModelRpcs, protocol: ElectronRpcProtocolLive }
) {
  // Credentials are invoked directly through the service client so no mutation atom retains their payload.
  static readonly refreshCatalog = ModelRpcClient.mutation(RefreshModelCatalog._tag)
}

/** One-shot credential-blind catalog shared by provider setup and Session model selection. */
export const modelCatalogAtom = ModelRpcClient.query('models.listCatalog', undefined)

/** Push-based atom retains only the latest renderer-safe model snapshot. */
export const modelsAtom = ModelRpcClient.runtime.atom(Stream.unwrap(
  Effect.map(ModelRpcClient, (client) => client('models.watch', undefined))
))
