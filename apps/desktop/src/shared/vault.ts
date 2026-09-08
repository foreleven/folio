import { Schema } from 'effect'

/** Global registry entry; new identities use UUID v7 and paths point to canonical content directories. */
export const Vault = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  name: Schema.NonEmptyString,
  path: Schema.NonEmptyString
})
export type Vault = typeof Vault.Type

/** Serializable failure for selecting, registering, or opening a vault. */
export class VaultError extends Schema.TaggedError<VaultError>()('VaultError', {
  message: Schema.String,
  cause: Schema.Defect()
}) {}
