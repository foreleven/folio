import { Effect, Stream } from 'effect'
import { AtomRpc } from 'effect/unstable/reactivity'
import {
  DeleteModelCredential,
  DeleteModelProfile,
  ModelRpcs,
  RebuildModelConfig,
  RefreshModelCatalog,
  SaveModelProfile,
  SetDefaultModelProfile,
  TestModelConnection
} from '../../../shared/rpc/model-rpc'
import { ElectronRpcProtocolLive } from './electron-rpc-protocol'

/** Exposes credential-blind model snapshots and explicit model mutations to settings views. */
export class ModelRpcClient extends AtomRpc.Service<ModelRpcClient>()(
  'folio/renderer/ModelRpcClient',
  { group: ModelRpcs, protocol: ElectronRpcProtocolLive }
) {
  static readonly saveProfile = ModelRpcClient.mutation(SaveModelProfile._tag)
  static readonly deleteProfile = ModelRpcClient.mutation(DeleteModelProfile._tag)
  static readonly setDefault = ModelRpcClient.mutation(SetDefaultModelProfile._tag)
  // Credentials are invoked directly through the service client so no mutation atom retains their payload.
  static readonly deleteCredential = ModelRpcClient.mutation(DeleteModelCredential._tag)
  static readonly refreshCatalog = ModelRpcClient.mutation(RefreshModelCatalog._tag)
  static readonly testConnection = ModelRpcClient.mutation(TestModelConnection._tag)
  static readonly rebuildDerivedConfig = ModelRpcClient.mutation(RebuildModelConfig._tag)
}

/** One-shot credential-blind catalog query used by the built-in profile picker. */
export const modelCatalogAtom = ModelRpcClient.query('models.listCatalog', undefined)

/** Push-based atom retains only the latest renderer-safe model snapshot. */
export const modelsAtom = ModelRpcClient.runtime.atom(Stream.unwrap(
  Effect.map(ModelRpcClient, (client) => client('models.watch', undefined))
))
