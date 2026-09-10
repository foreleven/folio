import { ModelProfile } from '@folio/agent/config/schema'
import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/unstable/rpc'
import { ModelCatalogView, ModelServiceError, ModelSettingsView } from '../model'

const ProfileId = Schema.Struct({ profileId: Schema.NonEmptyString })
const SettingsResult = { success: ModelSettingsView, error: ModelServiceError }

/** Provider setup does not create a model profile; the key only crosses this redacted request. */
export const SetProviderCredential = Rpc.make('models.setProviderCredential', {
  payload: Schema.Struct({
    providerId: Schema.NonEmptyString,
    credential: Schema.Redacted(Schema.NonEmptyString, { label: 'provider credential' })
  }),
  ...SettingsResult
})

/** Credential values exist only on this request and decode to Redacted in the main process. */
export const SetModelCredential = Rpc.make('models.setCredential', {
  payload: Schema.Struct({
    profileId: Schema.NonEmptyString,
    credential: Schema.Redacted(Schema.NonEmptyString, { label: 'model credential' })
  }),
  ...SettingsResult
})

export const WatchModels = Rpc.make('models.watch', {
  success: ModelSettingsView,
  error: ModelServiceError,
  stream: true
})
export const SaveModelProfile = Rpc.make('models.saveProfile', {
  payload: ModelProfile,
  ...SettingsResult
})
export const DeleteModelProfile = Rpc.make('models.deleteProfile', {
  payload: ProfileId,
  ...SettingsResult
})
export const SetDefaultModelProfile = Rpc.make('models.setDefault', {
  payload: Schema.Struct({ profileId: Schema.optionalKey(Schema.NonEmptyString) }),
  ...SettingsResult
})
export const DeleteModelCredential = Rpc.make('models.deleteCredential', {
  payload: ProfileId,
  ...SettingsResult
})
export const ListModelCatalog = Rpc.make('models.listCatalog', {
  success: ModelCatalogView,
  error: ModelServiceError
})
export const RefreshModelCatalog = Rpc.make('models.refreshCatalog', {
  success: ModelCatalogView,
  error: ModelServiceError
})
export const TestModelConnection = Rpc.make('models.testConnection', {
  payload: ProfileId,
  ...SettingsResult
})
export const RebuildModelConfig = Rpc.make('models.rebuildDerivedConfig', {
  success: Schema.Void,
  error: ModelServiceError
})

export class ModelRpcs extends RpcGroup.make(
  SetProviderCredential,
  WatchModels,
  SaveModelProfile,
  DeleteModelProfile,
  SetDefaultModelProfile,
  SetModelCredential,
  DeleteModelCredential,
  ListModelCatalog,
  RefreshModelCatalog,
  TestModelConnection,
  RebuildModelConfig
) {}
