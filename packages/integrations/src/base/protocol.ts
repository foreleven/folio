import { Schema } from 'effect'

/** Provider text travels with its translations; hosts never maintain provider-specific dictionaries. */
export const IntegrationText = Schema.Union([Schema.String, Schema.Struct({ en: Schema.String, 'zh-CN': Schema.String })])
export type IntegrationText = typeof IntegrationText.Type

/** Resolves provider text for a supported host locale without interpreting business identifiers. */
export function integrationText(text: IntegrationText, locale: 'en' | 'zh-CN'): string {
  return typeof text === 'string' ? text : text[locale]
}

/** Semantic appearance is shared; state IDs and their meaning remain provider-owned. */
export const IntegrationStatus = Schema.Struct({
  kind: Schema.Literals(['ready', 'working', 'waiting', 'attention', 'unavailable']),
  label: IntegrationText,
  description: Schema.optional(IntegrationText)
})
export type IntegrationStatus = typeof IntegrationStatus.Type

/** Inputs have no stored/default values: credentials only travel in a submitted callback payload. */
export const IntegrationField = Schema.Struct({
  id: Schema.NonEmptyString, label: IntegrationText,
  type: Schema.Literals(['text', 'password']), required: Schema.Boolean,
  description: Schema.optional(IntegrationText)
})

/** Static descriptions remain available before installation and while an operation is running. */
export const IntegrationActionDefinition = Schema.Struct({
  id: Schema.NonEmptyString, label: IntegrationText, description: Schema.optional(IntegrationText),
  fields: Schema.optional(Schema.Array(IntegrationField))
})
export type IntegrationActionDefinition = typeof IntegrationActionDefinition.Type

/** Providers explicitly nominate the primary action; absence means a secondary menu action. */
export const IntegrationAction = Schema.Union([
  Schema.Struct({ id: Schema.NonEmptyString, type: Schema.Literal('callback'), primary: Schema.optional(Schema.Boolean) }),
  Schema.Struct({ id: Schema.NonEmptyString, type: Schema.Literal('open-url'), url: Schema.String, primary: Schema.optional(Schema.Boolean) })
])
export type IntegrationAction = typeof IntegrationAction.Type
