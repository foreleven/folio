import { SqliteClient } from '@effect/sql-sqlite-node'
import { Context, Effect, FileSystem, Layer, Schema } from 'effect'
import { Reactivity } from 'effect/unstable/reactivity'
import { join } from 'node:path'
import { IntegrationRecord, IntegrationSettingsError } from '../../shared/integration'
import { ConfigService } from './config-service'

const Row = Schema.Struct({
  id: Schema.String, state: Schema.String, data: Schema.fromJsonString(Schema.Unknown),
  actions: Schema.fromJsonString(IntegrationRecord.fields.actions),
  resources: Schema.fromJsonString(IntegrationRecord.fields.resources),
  error: Schema.NullOr(Schema.String), createdAt: Schema.Number, updatedAt: Schema.Number
})
const storageError = () => new IntegrationSettingsError({ message: 'Could not save or read integration settings.' })

/** Global installation state; opening the store creates the table but never installs an integration. */
export class IntegrationStore extends Context.Service<IntegrationStore, {
  readonly list: Effect.Effect<readonly IntegrationRecord[], IntegrationSettingsError>
  readonly create: (id: string) => Effect.Effect<void, IntegrationSettingsError>
  readonly update: (id: string, state: string, data: unknown, actions: IntegrationRecord['actions'], error?: string) => Effect.Effect<void, IntegrationSettingsError>
  readonly register: (id: string, resource: { id: string; name: string }) => Effect.Effect<void, IntegrationSettingsError>
}>()('folio/services/IntegrationStore') {
  static readonly layer = Layer.effect(IntegrationStore, Effect.gen(function*() {
    const { directory } = yield* ConfigService
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
    const sql = yield* SqliteClient.make({ filename: join(directory, 'data.db') }).pipe(Effect.catchDefect(() => Effect.fail(storageError())))
    yield* fs.chmod(join(directory, 'data.db'), 0o600)
    yield* sql`CREATE TABLE IF NOT EXISTS integration_states (
      id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}',
      actions TEXT NOT NULL DEFAULT '[]', resources TEXT NOT NULL DEFAULT '[]', error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`
    // Old installations stored only IDs. Reconciliation rebuilds executable actions from provider facts;
    // never infer an external action or revive an authorization URL from legacy opaque data.
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(integration_states)`
    if (!columns.some((column) => column.name === 'actions')) {
      yield* sql`ALTER TABLE integration_states ADD COLUMN actions TEXT NOT NULL DEFAULT '[]'`
    }
    const list = sql`SELECT id, state, data, actions, resources, error,
      created_at AS createdAt, updated_at AS updatedAt FROM integration_states ORDER BY id`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Row))), Effect.mapError(storageError)
    )
    /** Inserts the first row on explicit installation only; retries preserve previous committed state. */
    const create = Effect.fn('IntegrationStore.create')(function*(id: string) {
      const now = Date.now()
      yield* sql`INSERT INTO integration_states (id, state, created_at, updated_at)
        VALUES (${id}, 'checking', ${now}, ${now}) ON CONFLICT(id) DO NOTHING`
    }, Effect.mapError(storageError))
    /** Updates state and opaque data together, preserving separately registered resources. */
    const update = Effect.fn('IntegrationStore.update')(function*(id: string, state: string, data: unknown, actions: IntegrationRecord['actions'], error?: string) {
      const json = yield* Effect.try(() => JSON.stringify(data))
      if (json === undefined) return yield* storageError()
      const changed = yield* sql`UPDATE integration_states SET state=${state}, data=${json},
        actions=${JSON.stringify(actions)}, error=${error ?? null}, updated_at=${Date.now()} WHERE id=${id} RETURNING id`
      if (changed.length === 0) return yield* storageError()
    }, Effect.mapError(storageError))
    /** Upserts metadata transactionally so installing twice does not duplicate resources. */
    const register = Effect.fn('IntegrationStore.register')(function*(id: string, resource: { id: string; name: string }) {
      yield* sql.withTransaction(Effect.gen(function*() {
        const record = (yield* list).find((row) => row.id === id)
        if (!record) return yield* storageError()
        const resources = [...record.resources.filter((item) => item.id !== resource.id), resource]
        yield* sql`UPDATE integration_states SET resources=${JSON.stringify(resources)}, updated_at=${Date.now()} WHERE id=${id}`
      }))
    }, Effect.mapError(storageError))
    return IntegrationStore.of({ list, create, update, register })
  }).pipe(Effect.mapError(storageError))).pipe(Layer.provide(Reactivity.layer))
}
