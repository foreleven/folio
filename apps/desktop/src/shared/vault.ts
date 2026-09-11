import { Schema } from 'effect'

/** Global registry entry; UUID v7 identity and stable user entry path, linking to managed workspace/wiki. */
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
