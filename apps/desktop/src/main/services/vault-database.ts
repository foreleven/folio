import { SqliteClient } from '@effect/sql-sqlite-node'
import { Context, Effect, Layer } from 'effect'
import { Reactivity } from 'effect/unstable/reactivity'
import { SqlClient } from 'effect/unstable/sql'
import { join } from 'node:path'
import { VaultError } from '../../shared/vault'

/**
 * Opens data.db in an existing, trusted vault configuration directory.
 * Provides Effect SQL clients for this vault only; the consuming scope closes
 * the connection on success, failure, or interruption. Existing data is preserved.
 */
export function vaultDatabaseLayer(directory: string) {
  return Layer.effectContext(Effect.gen(function*() {
    // The driver throws on open/PRAGMA failures; expose them as recoverable vault
    // errors so a damaged or unwritable database cannot silently open a vault.
    const client = yield* SqliteClient.make({ filename: join(directory, 'data.db') }).pipe(
      Effect.catchDefect((cause) => Effect.fail(new VaultError({
        message: 'Could not open the vault database. Check the vault configuration directory.',
        cause
      })))
    )
    return Context.make(SqliteClient.SqliteClient, client).pipe(
      Context.add(SqlClient.SqlClient, client)
    )
  })).pipe(Layer.provide(Reactivity.layer))
}
