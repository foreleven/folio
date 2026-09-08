import { Effect, Schema } from 'effect'
import { Vault } from './vault'

/** Persisted preferences; `system` delegates resolution to the consuming UI. */
export const Theme = Schema.Literals(['system', 'light', 'dark'])
export const Language = Schema.Literals(['system', 'zh-CN', 'en'])

/** Missing fields use defaults so older config files remain readable. */
export const GlobalConfig = Schema.Struct({
  theme: Theme.pipe(Schema.withDecodingDefaultKey(Effect.succeed('system'))),
  language: Language.pipe(Schema.withDecodingDefaultKey(Effect.succeed('system'))),
  vaults: Schema.Array(Vault).pipe(Schema.withDecodingDefaultKey(Effect.succeed([])))
})

export type GlobalConfig = typeof GlobalConfig.Type

/** Updates only supplied fields; explicit undefined and invalid values fail validation. */
export const GlobalConfigPatch = Schema.Struct({
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
