import { ModelProfile } from '@folio/agent/config/schema'
import { Schema } from 'effect'

export const ModelConnectionStatus = Schema.Literals(['untested', 'ready', 'unavailable'])
export type ModelConnectionStatus = typeof ModelConnectionStatus.Type

export const ModelCatalogEntry = Schema.Struct({
  providerId: Schema.NonEmptyString,
  providerName: Schema.NonEmptyString,
  modelId: Schema.NonEmptyString,
  modelName: Schema.NonEmptyString,
  api: Schema.NonEmptyString,
  source: Schema.Literals(['builtin', 'custom']),
  reasoning: Schema.Boolean,
  input: Schema.Array(Schema.Literals(['text', 'image'])),
  contextWindow: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  maxTokens: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))
})
export type ModelCatalogEntry = typeof ModelCatalogEntry.Type

export const ModelCatalogView = Schema.Struct({
  models: Schema.Array(ModelCatalogEntry),
  stale: Schema.Boolean
})
export type ModelCatalogView = typeof ModelCatalogView.Type

/** Renderer-safe model state. Credential values and environment values are intentionally absent. */
export const ModelProfileView = Schema.Struct({
  profile: ModelProfile,
  credentialConfigured: Schema.Boolean,
  connectionStatus: ModelConnectionStatus
})
export type ModelProfileView = typeof ModelProfileView.Type

export const ModelSettingsView = Schema.Struct({
  enabled: Schema.Boolean,
  configuredProviders: Schema.optionalKey(Schema.Array(Schema.String)),
  piImportFailed: Schema.optionalKey(Schema.Boolean),
  defaultModelProfileId: Schema.optionalKey(Schema.String),
  profiles: Schema.Array(ModelProfileView)
})
export type ModelSettingsView = typeof ModelSettingsView.Type

export const ModelServiceFailureReason = Schema.Literals([
  'invalid_profile',
  'profile_not_found',
  'default_profile_delete',
  'config_unavailable',
  'credential_unavailable',
  'credential_shared',
  'derived_config_unavailable',
  'catalog_unavailable',
  'provider_unavailable',
  'operation_aborted'
])
export type ModelServiceFailureReason = typeof ModelServiceFailureReason.Type

/** Serializable, finite and secret-free failure shared by ModelService and future RPC clients. */
export class ModelServiceError extends Schema.TaggedError<ModelServiceError>()(
  'ModelServiceError',
  {
    reason: ModelServiceFailureReason,
    message: Schema.String
  }
) {}
