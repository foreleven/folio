import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk/experimental/v2'
import { Context, DateTime, Effect, Layer, Schema } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { HarnessStoreError } from '../../shared/harness'
import { ProjectionRow, RecordedUpdate, ProtocolAssociation, ProtocolFrame, RecordedProtocolFrame, ProtocolDiagnosticRow, RecordedProtocolDiagnostic } from '../../shared/harness-events'
import { projectUpdate } from './acp-projection'

const now = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis))
const failure = () => new HarnessStoreError({ reason: 'storage', message: 'Could not persist or project ACP history.' })
const invalid = () => new HarnessStoreError({ reason: 'invalid-state', message: 'ACP history identity or order does not match the saved session.' })
const safeError = (error: unknown) => error instanceof HarnessStoreError ? error : failure()
const CanonicalRow = Schema.Struct({
  sourceSequence: Schema.Int, runId: Schema.NullOr(Schema.String), payload: Schema.fromJsonString(Schema.JsonObject)
})

/**
 * Vault-authoritative received updates and display projection, committed in the same transaction.
 * Replay receipts remain visible, but each immutable adapter archive position is projected only once.
 */
export class HarnessEventStore extends Context.Service<HarnessEventStore, {
  readonly lastSequence: (sessionId: string) => Effect.Effect<number, HarnessStoreError>
  readonly appendUpdate: (input: RecordedUpdate) => Effect.Effect<{ duplicate: boolean }, HarnessStoreError>
  readonly appendProtocol: (input: RecordedProtocolFrame) => Effect.Effect<void, HarnessStoreError>
  readonly appendProtocolDiagnostic: (input: RecordedProtocolDiagnostic) => Effect.Effect<void, HarnessStoreError>
  readonly protocol: (sessionId: string) => Effect.Effect<readonly ProtocolFrame[], HarnessStoreError>
  readonly diagnostics: (sessionId: string) => Effect.Effect<readonly ProtocolDiagnosticRow[], HarnessStoreError>
  readonly messages: (sessionId: string) => Effect.Effect<readonly ProjectionRow[], HarnessStoreError>
  readonly rebuild: (sessionId: string) => Effect.Effect<void, HarnessStoreError>
}>()('folio/services/HarnessEventStore') {
  static readonly layer = Layer.effect(HarnessEventStore, Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    /** Reads message/tool projections in first-observed order, scoped by Folio Session identity. */
    const read = Effect.fn('HarnessEventStore.read')((kind: 'message' | 'tool_call', sessionId: string) =>
      sql`SELECT id, run_id AS runId, kind, first_sequence AS firstSequence, last_sequence AS lastSequence, data
        FROM messages WHERE session_id=${sessionId} AND kind=${kind} ORDER BY first_sequence, id`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ProjectionRow)))
      ), Effect.mapError(safeError))

    /** Runs only inside the caller's transaction; no UI signal may precede its commit. */
    const project = Effect.fn('HarnessEventStore.project')(function*(sessionId: string, runId: string | null, sequence: number, update: Schema.JsonObject) {
      const change = yield* Effect.try(() => projectUpdate(update))
      if (change.kind === 'none') return
      if (change.kind === 'idle') {
        yield* sql`UPDATE messages SET data=json_set(data, '$.ended', json('true')), last_sequence=${sequence}
          WHERE session_id=${sessionId} AND kind='message' AND json_extract(data, '$.ended')=0`
        return
      }
      const kind = change.kind === 'message' ? 'message' : 'tool_call'
      const rows = yield* sql`SELECT id, run_id AS runId, kind, first_sequence AS firstSequence, last_sequence AS lastSequence, data
        FROM messages WHERE session_id=${sessionId} AND kind=${kind} AND id=${change.id}`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ProjectionRow)))
      )
      const previous = rows[0]
      // Protocol identities are Session-scoped; silently reusing one for another Run would merge unrelated output.
      if (previous && previous.runId !== null && runId !== null && previous.runId !== runId) return yield* invalid()
      const data = yield* Effect.try(() => JSON.stringify(change.apply(previous?.data)))
      yield* sql`INSERT INTO messages (session_id, id, run_id, kind, first_sequence, last_sequence, data, received_at)
        VALUES (${sessionId}, ${change.id}, ${runId}, ${kind}, ${sequence}, ${sequence}, ${data}, ${yield* now})
        ON CONFLICT(session_id, kind, id) DO UPDATE SET last_sequence=excluded.last_sequence, data=excluded.data`
    })

    /** Highest canonical archive position; recovery must not accept a shortened replay file. */
    const lastSequence = Effect.fn('HarnessEventStore.lastSequence')((sessionId: string) =>
      sql`SELECT coalesce(max(source_sequence), 0) AS position FROM messages WHERE session_id=${sessionId} AND kind='acp_update'`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ position: Schema.Int })))),
        Effect.map(rows => rows[0]!.position), Effect.mapError(safeError)
      ))

    /** Requires the verified Folio sequence extension; gaps/mutated replay fail instead of guessing chunk identity. */
    const appendUpdate = Effect.fn('HarnessEventStore.appendUpdate')(function*(input: RecordedUpdate) {
      const value = yield* Schema.decodeUnknownEffect(RecordedUpdate)(input, { onExcessProperty: 'preserve' })
      const sequence = value.notification._meta['folio/eventSequence']
      const payload = JSON.stringify(value.notification.update)
      return yield* sql.withTransaction(Effect.gen(function*() {
        const bound = yield* sql`SELECT id FROM sessions WHERE id=${value.sessionId} AND acp_session_id=${value.notification.sessionId}`
        if (!bound.length) return yield* invalid()
        if (value.runId !== null) {
          const run = yield* sql`SELECT id FROM runs WHERE id=${value.runId} AND session_id=${value.sessionId}`
          if (!run.length) return yield* invalid()
        }
        const existing = yield* sql`SELECT source_sequence AS sourceSequence, run_id AS runId, data AS payload FROM messages
          WHERE session_id=${value.sessionId} AND kind='acp_update' AND source_sequence=${sequence}`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(CanonicalRow)))
        )
        const original = existing[0]
        if (original && !isDeepStrictEqual(original.payload, value.notification.update)) return yield* invalid()
        const received = yield* now
        if (!original) {
          if (sequence !== (yield* lastSequence(value.sessionId)) + 1) return yield* invalid()
          yield* sql`INSERT INTO messages (session_id, id, run_id, kind, source_sequence, first_sequence, last_sequence, data, received_at)
            VALUES (${value.sessionId}, ${String(sequence)}, ${value.runId}, 'acp_update', ${sequence}, ${sequence}, ${sequence}, ${payload}, ${received})`
          yield* project(value.sessionId, value.runId, sequence, value.notification.update)
        }
        return { duplicate: original !== undefined }
      }))
    }, Effect.mapError(safeError))

    /** Reconstructs projections from canonical raw updates atomically; receipt order does not reapply replay chunks. */
    const rebuild = Effect.fn('HarnessEventStore.rebuild')(function*(sessionId: string) {
      yield* sql.withTransaction(Effect.gen(function*() {
        const updates = yield* sql`SELECT source_sequence AS sourceSequence, run_id AS runId, data AS payload FROM messages
          WHERE session_id=${sessionId} AND kind='acp_update' ORDER BY source_sequence`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(CanonicalRow))))
        yield* sql`DELETE FROM messages WHERE session_id=${sessionId} AND kind IN ('message', 'tool_call')`
        for (const update of updates) yield* project(sessionId, update.runId, update.sourceSequence, update.payload)
      }))
    }, Effect.mapError(safeError))

    /** Persist before SDK dispatch; pre-binding initialize/new frames still belong to the allocated Folio Session. */
    const appendProtocol = Effect.fn('HarnessEventStore.appendProtocol')(function*(input: RecordedProtocolFrame) {
      const value = yield* Schema.decodeUnknownEffect(RecordedProtocolFrame)(input)
      yield* sql.withTransaction(Effect.gen(function*() {
        for (const runId of new Set(value.associations.flatMap(item => item.runId ? [item.runId] : []))) {
          if (!(yield* sql`SELECT id FROM runs WHERE id=${runId} AND session_id=${value.sessionId}`).length) return yield* invalid()
        }
        const received = yield* now
        yield* sql`INSERT INTO messages (session_id, id, run_id, kind, first_sequence, last_sequence, data, received_at)
          VALUES (${value.sessionId}, ${randomUUID()}, ${value.associations.find(item => item.runId)?.runId ?? null}, 'protocol',
            (SELECT coalesce(max(first_sequence), 0) + 1 FROM messages WHERE session_id=${value.sessionId}),
            (SELECT coalesce(max(first_sequence), 0) + 1 FROM messages WHERE session_id=${value.sessionId}),
            ${JSON.stringify({ connectionId: value.connectionId, direction: value.direction, payload: value.payload, associations: value.associations, protocolVersion: PROTOCOL_VERSION })}, ${received})`
      }))
    }, Effect.mapError(safeError))
    /** Read decoded transport observations without replaying them into UI projections. */
    const protocol = Effect.fn('HarnessEventStore.protocol')((sessionId: string) => sql`SELECT first_sequence AS sequence,
      session_id AS sessionId, json_extract(data, '$.connectionId') AS connectionId,
      json_extract(data, '$.direction') AS direction, json_extract(data, '$.payload') AS payload,
      json_extract(data, '$.associations') AS associations, json_extract(data, '$.protocolVersion') AS protocolVersion,
      received_at AS receivedAt FROM messages WHERE session_id=${sessionId} AND kind='protocol' ORDER BY first_sequence`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({
        ...ProtocolFrame.fields, payload: Schema.Json, associations: Schema.Array(ProtocolAssociation)
      })))), Effect.mapError(safeError))
    )
    /** Persists only bounded malformed-wire metadata; raw bytes never enter the Vault. */
    const appendProtocolDiagnostic = Effect.fn('HarnessEventStore.appendProtocolDiagnostic')(function*(input: RecordedProtocolDiagnostic) {
      const value = yield* Schema.decodeUnknownEffect(RecordedProtocolDiagnostic)(input)
      yield* sql.withTransaction(Effect.gen(function*() {
        if (!(yield* sql`SELECT id FROM sessions WHERE id=${value.sessionId}`).length) return yield* invalid()
        const received = yield* now
        yield* sql`INSERT INTO messages (session_id, id, run_id, kind, first_sequence, last_sequence, data, received_at)
          VALUES (${value.sessionId}, ${randomUUID()}, NULL, 'diagnostic',
            (SELECT coalesce(max(first_sequence), 0) + 1 FROM messages WHERE session_id=${value.sessionId}),
            (SELECT coalesce(max(first_sequence), 0) + 1 FROM messages WHERE session_id=${value.sessionId}),
            ${JSON.stringify({ connectionId: value.connectionId, direction: value.direction, ...value.diagnostic })}, ${received})`
      }))
    }, Effect.mapError(safeError))
    const diagnostics = Effect.fn('HarnessEventStore.diagnostics')((sessionId: string) => sql`SELECT first_sequence AS sequence,
      session_id AS sessionId, json_extract(data, '$.connectionId') AS connectionId,
      json_extract(data, '$.direction') AS direction, json_extract(data, '$.reason') AS reason,
      json_extract(data, '$.byteLength') AS byteLength, json_extract(data, '$.sha256') AS sha256,
      received_at AS receivedAt FROM messages WHERE session_id=${sessionId} AND kind='diagnostic' ORDER BY first_sequence`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ProtocolDiagnosticRow))), Effect.mapError(safeError)))
    return HarnessEventStore.of({ lastSequence, appendUpdate, appendProtocol, appendProtocolDiagnostic, protocol, diagnostics,
      messages: (id) => sql`SELECT id, run_id AS runId, kind, first_sequence AS firstSequence, last_sequence AS lastSequence, data
        FROM messages WHERE session_id=${id} AND kind IN ('message', 'tool_call') ORDER BY first_sequence, id`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ProjectionRow))), Effect.mapError(safeError)),
      rebuild })
  }))
}
