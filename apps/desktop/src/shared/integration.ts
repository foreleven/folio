import { Schema } from 'effect'

export class IntegrationSettingsError extends Schema.TaggedError<IntegrationSettingsError>()('IntegrationSettingsError', {
  message: Schema.String
}) {}

export const IntegrationAction = Schema.Struct({ id: Schema.String, label: Schema.String, description: Schema.optional(Schema.String) })
export const IntegrationResource = Schema.Struct({ id: Schema.String, name: Schema.String })
export const IntegrationRecord = Schema.Struct({
  id: Schema.String, state: Schema.String, data: Schema.Unknown,
  actionIds: Schema.Array(Schema.String), resources: Schema.Array(IntegrationResource),
  error: Schema.NullOr(Schema.String), createdAt: Schema.Number, updatedAt: Schema.Number
})
export type IntegrationRecord = typeof IntegrationRecord.Type

/** Public catalog plus committed setup state. No app credentials cross RPC. */
export const IntegrationView = Schema.Struct({
  id: Schema.String, name: Schema.String,
  description: Schema.String, logo: Schema.String, homepage: Schema.String,
  actions: Schema.Array(IntegrationAction), resources: Schema.Array(IntegrationResource),
  record: Schema.NullOr(IntegrationRecord), busy: Schema.Boolean
})
export type IntegrationView = typeof IntegrationView.Type
