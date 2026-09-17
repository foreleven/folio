import { SqliteClient } from '@effect/sql-sqlite-node'
import { Context, DateTime, Effect, FileSystem, Layer, PubSub, Schema, Stream } from 'effect'
import { Reactivity } from 'effect/unstable/reactivity'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { ExecutionEvent, ExecutionEventInput, ExecutionEventPayload } from '../../shared/execution-events'
import { HarnessStoreError } from '../../shared/harness'
import { ConfigService } from './config-service'

const failure = (reason: HarnessStoreError['reason'] = 'storage') => new HarnessStoreError({ reason,
  message: 'Could not persist or replay execution events.' })
const safe = (error: unknown) => error instanceof HarnessStoreError ? error : failure()
const Row = Schema.Struct({ ...ExecutionEvent.fields, payload: Schema.fromJsonString(ExecutionEventPayload) })
const decode = Schema.decodeUnknownEffect(Schema.Array(Row), { onExcessProperty: 'preserve' })

/**
 * Application-owned durable event bus. Append commits before notifying subscribers; notifications
 * may be lost, but ordered journal records remain replayable until each Vault projects them.
 * Its SQL connection is private so callers cannot accidentally write Vault data into this database.
 */
export class ExecutionEventLog extends Context.Service<ExecutionEventLog, {
  readonly append: (input: ExecutionEventInput) => Effect.Effect<ExecutionEvent, HarnessStoreError>
  readonly after: (vaultId: string, sequence: number) => Effect.Effect<readonly ExecutionEvent[], HarnessStoreError>
  readonly unstoppedProcesses: (vaultId: string) => Effect.Effect<readonly number[], HarnessStoreError>
  readonly changes: Stream.Stream<string>
}>()('folio/services/ExecutionEventLog') {
  static readonly layer = Layer.effect(ExecutionEventLog, Effect.gen(function* () {
    const config = yield* ConfigService
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(config.directory, { recursive: true })
    const sql = yield* SqliteClient.make({ filename: join(config.directory, 'execution-events.db') })
    yield* sql`PRAGMA journal_mode=WAL`
    yield* sql`PRAGMA synchronous=FULL`
    yield* sql`CREATE TABLE IF NOT EXISTS execution_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
      vault_id TEXT NOT NULL, task_id TEXT NOT NULL, session_id TEXT NOT NULL,
      run_id TEXT NOT NULL, attempt_id TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), created_at INTEGER NOT NULL
    )`
    yield* sql`CREATE INDEX IF NOT EXISTS execution_events_by_vault ON execution_events(vault_id, sequence)`
    const notifications = yield* PubSub.unbounded<string>()
    yield* Effect.addFinalizer(() => PubSub.shutdown(notifications))
    const select = sql`SELECT sequence, event_id AS eventId, vault_id AS vaultId, task_id AS taskId,
      session_id AS sessionId, run_id AS runId, attempt_id AS attemptId, payload, created_at AS createdAt FROM execution_events`
    const append = Effect.fn('ExecutionEventLog.append')(function* (input: ExecutionEventInput) {
      const value = yield* Schema.decodeUnknownEffect(ExecutionEventInput)(input, { onExcessProperty: 'preserve' })
      const saved = yield* sql.withTransaction(Effect.gen(function* () {
        const previous = (yield* sql`${select} WHERE event_id=${value.eventId}`.pipe(Effect.flatMap(decode)))[0]
        if (previous) {
          const { sequence: _sequence, createdAt: _createdAt, ...intent } = previous
          if (!isDeepStrictEqual(intent, value)) return yield* failure('invalid-state')
          return previous
        }
        const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis))
        yield* sql`INSERT INTO execution_events (event_id, vault_id, task_id, session_id, run_id, attempt_id, payload, created_at)
          VALUES (${value.eventId}, ${value.vaultId}, ${value.taskId}, ${value.sessionId}, ${value.runId}, ${value.attemptId}, ${JSON.stringify(value.payload)}, ${createdAt})`
        return (yield* sql`${select} WHERE event_id=${value.eventId}`.pipe(Effect.flatMap(decode)))[0]!
      }))
      yield* PubSub.publish(notifications, value.vaultId)
      return saved
    }, Effect.mapError(safe))
    const after = (vaultId: string, sequence: number) => sql`${select} WHERE vault_id=${vaultId} AND sequence>${sequence}
      ORDER BY sequence LIMIT 256`.pipe(Effect.flatMap(decode), Effect.mapError(safe))
    const unstoppedProcesses = (vaultId: string) => sql<{ pid: number }>`SELECT json_extract(started.payload, '$.pid') AS pid
      FROM execution_events started WHERE started.vault_id=${vaultId} AND json_extract(started.payload, '$._tag')='process-started'
      AND NOT EXISTS (SELECT 1 FROM execution_events stopped WHERE stopped.vault_id=started.vault_id
        AND stopped.run_id=started.run_id AND stopped.attempt_id=started.attempt_id AND json_extract(stopped.payload, '$._tag')='process-stopped'
        AND (json_extract(stopped.payload, '$.pid') IS NULL OR json_extract(stopped.payload, '$.pid')=json_extract(started.payload, '$.pid')))
      UNION ALL
      SELECT json_extract(started.payload, '$.ownerPid') AS pid FROM execution_events started
      WHERE started.vault_id=${vaultId} AND json_extract(started.payload, '$._tag')='worker-started'
      AND NOT EXISTS (SELECT 1 FROM execution_events stopped WHERE stopped.vault_id=started.vault_id
        AND stopped.run_id=started.run_id AND stopped.attempt_id=started.attempt_id AND json_extract(stopped.payload, '$._tag')='worker-stopped')`
      .pipe(Effect.map(rows => rows.map(row => row.pid)), Effect.mapError(safe))
    return ExecutionEventLog.of({ append, after, unstoppedProcesses, changes: Stream.fromPubSub(notifications) })
  })).pipe(Layer.provide(Reactivity.layer))
}
