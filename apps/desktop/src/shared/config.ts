import { AgentSettings } from '@folio/agent/config/schema'
import { Effect, Schema } from 'effect'
import { Vault } from './vault'

/** Persisted preferences; `system` delegates resolution to the consuming UI. */
export const Theme = Schema.Literals(['system', 'light', 'dark'])
export const Language = Schema.Literals(['system', 'zh-CN', 'en'])

/** Missing fields use defaults so older config files remain readable. */
export const GlobalConfig = Schema.Struct({
  executionConcurrency: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(32))),
  theme: Theme.pipe(Schema.withDecodingDefaultKey(Effect.succeed('system'))),
  language: Language.pipe(Schema.withDecodingDefaultKey(Effect.succeed('system'))),
  vaults: Schema.Array(Vault).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  // AgentSettings has nested defaults; use a type-side default so `{}` is not
  // interpreted as an encoded object missing its required nested fields.
  agent: AgentSettings.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed({
    enabled: false,
    modelProfiles: []
  })))
})

export type GlobalConfig = typeof GlobalConfig.Type

/** Updates only supplied fields; explicit undefined and invalid values fail validation. */
export const GlobalConfigPatch = Schema.Struct({
  executionConcurrency: GlobalConfig.fields.executionConcurrency,
  theme: Schema.optionalKey(Theme),
  language: Schema.optionalKey(Language)
})

export type GlobalConfigPatch = typeof GlobalConfigPatch.Type

/** Serializable storage failure shared by the main service and renderer RPC clients. */
export class ConfigStoreError extends Schema.TaggedError<ConfigStoreError>()(
  'ConfigStoreError',
  {
    path: Schema.String,
    operation: Schema.Literals(['read', 'update']),
    cause: Schema.Defect()
  }
) {}
