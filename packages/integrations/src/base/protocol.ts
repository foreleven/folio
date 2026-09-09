import { Schema } from 'effect'

/** Static action labels remain available before installation and while an operation is running. */
export const IntegrationActionDefinition = Schema.Struct({
  id: Schema.NonEmptyString, label: Schema.NonEmptyString, description: Schema.optional(Schema.String)
})
export type IntegrationActionDefinition = typeof IntegrationActionDefinition.Type

/** An available action names a static definition and tells the host how to execute it. */
export const IntegrationAction = Schema.Union([
  Schema.Struct({ id: Schema.NonEmptyString, type: Schema.Literal('callback') }),
  Schema.Struct({ id: Schema.NonEmptyString, type: Schema.Literal('open-url'), url: Schema.String })
])
export type IntegrationAction = typeof IntegrationAction.Type
