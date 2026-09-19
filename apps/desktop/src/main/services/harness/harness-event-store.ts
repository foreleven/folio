import { Context, Effect, Layer, Predicate, Schema, Semaphore } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { createHash } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import { HarnessStoreError } from '../../../shared/harness'
import { MessageRecord, MessagePayload, RecordedUpdate } from '../../../shared/harness-events'
import { projectUpdate } from './acp-projection'

const failure = () => new HarnessStoreError({ reason: 'storage', message: 'Could not persist or project ACP history.' })
const invalid = () => new HarnessStoreError({ reason: 'invalid-state', message: 'ACP history identity or order does not match the saved session.' })
const safeError = (error: unknown) => error instanceof HarnessStoreError ? error : failure()
type TimelineRow = MessageRecord
const StoredRow = Schema.Struct({ ...MessageRecord.fields, payload: Schema.fromJsonString(MessagePayload) })
type SessionState = { binding: string | null; rows: Map<string, TimelineRow>; position: number; fingerprints: Map<number, string>; runs: Set<string> }
const key = (row: TimelineRow) => `${row.payload.kind}:${row.payload.protocolId}`

/** Object property order is not part of ACP replay identity. */
function canonical(value: Schema.Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Schema.JsonObject)[k]!)}`).join(',')}}`
  return JSON.stringify(value)
}
const fingerprint = (value: Schema.Json) => createHash('sha256').update(canonical(value)).digest('hex')
const terminal = (row: TimelineRow) => row.payload.kind === 'message' ? row.payload.data.ended === true
  : row.payload.kind === 'tool_call' ? ['completed', 'failed'].includes(String(row.payload.data.status)) || row.payload.data.incomplete === true : true

/**
 * ACP deltas live only in the session buffer, which also backs live history reads.
 * Completion commits the full record. Saved message event positions and the adapter archive
 * remains the source for reconstructing a partially received message after a crash.
 */
export class HarnessEventStore extends Context.Service<HarnessEventStore, {
  readonly lastSequence: (sessionId: string) => Effect.Effect<number, HarnessStoreError>
  readonly appendUpdate: (input: RecordedUpdate) => Effect.Effect<{ duplicate: boolean }, HarnessStoreError>
  readonly finishSession: (sessionId: string) => Effect.Effect<void, HarnessStoreError>
  readonly messages: (sessionId: string) => Effect.Effect<readonly MessageRecord[], HarnessStoreError>
}>()('folio/services/HarnessEventStore') {
  static readonly layer = Layer.effect(HarnessEventStore, Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const gate = yield* Semaphore.make(1)
    const sessions = new Map<string, SessionState>()

    const load = Effect.fn('HarnessEventStore.load')(function*(sessionId: string) {
      const cached = sessions.get(sessionId)
      if (cached) return cached
      const session = (yield* sql<{ binding: string | null }>`SELECT acp_session_id AS binding FROM sessions WHERE id=${sessionId}`)[0]
      if (!session) return yield* invalid()
      const records = yield* sql`SELECT id, session_id AS sessionId, run_id AS runId, seq, type, timestamp, payload
        FROM messages WHERE session_id=${sessionId} ORDER BY seq`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(StoredRow))))
      const state: SessionState = { binding: session.binding, rows: new Map(records.map(row => [key(row), row])),
        position: records.reduce((max, row) => Math.max(max, row.payload.lastSequence), 0),
        fingerprints: new Map(), runs: new Set() }
      sessions.set(sessionId, state)
      return state
    })

    /** Only complete records are durable; unfinished buffers are reconstructed from the Agent archive. */
    const persist = Effect.fn('HarnessEventStore.persist')(function*(records: readonly TimelineRow[]) {
      yield* sql.withTransaction(Effect.gen(function*() {
        for (const row of records) {
          yield* sql`INSERT INTO messages (id, session_id, run_id, seq, type, timestamp, payload)
            VALUES (${row.id}, ${row.sessionId}, ${row.runId}, ${row.seq}, ${row.type}, ${row.timestamp}, ${JSON.stringify(row.payload)})
            ON CONFLICT(id) DO UPDATE SET type=excluded.type, payload=excluded.payload`
        }
      }))
    })
    const newRow = (state: SessionState, sessionId: string, runId: string | null, kind: TimelineRow['payload']['kind'], protocolId: string, sequence: number): TimelineRow => ({
      id: uuidv7(), sessionId, runId, seq: [...state.rows.values()].reduce((max, row) => Math.max(max, row.seq), 0) + 1,
      type: kind === 'message' || kind === 'tool_call' ? 'message' : 'custom', timestamp: Date.now(),
      payload: { kind, protocolId, firstSequence: sequence, lastSequence: sequence, data: {} }
    })

    const appendUpdate = Effect.fn('HarnessEventStore.appendUpdate')(function*(input: RecordedUpdate) {
      const value = yield* Schema.decodeUnknownEffect(RecordedUpdate)(input, { onExcessProperty: 'preserve' })
      const state = yield* load(value.sessionId)
      if (state.binding !== value.notification.sessionId) {
        // A session may have been read by the UI before its worker bound ACP identity.
        const bound = (yield* sql<{ binding: string | null }>`SELECT acp_session_id AS binding FROM sessions WHERE id=${value.sessionId}`)[0]
        if (bound?.binding !== value.notification.sessionId) return yield* invalid()
        state.binding = bound.binding
      }
      if (value.runId && !state.runs.has(value.runId)) {
        if (!(yield* sql`SELECT id FROM runs WHERE id=${value.runId} AND session_id=${value.sessionId}`).length) return yield* invalid()
        state.runs.add(value.runId)
      }
      const sequence = value.notification._meta['folio/eventSequence']
      const hash = fingerprint(value.notification.update)
      const previousHash = state.fingerprints.get(sequence)
      if (previousHash !== undefined && previousHash !== hash) return yield* invalid()
      if (previousHash === undefined && sequence > state.position + 1) return yield* invalid()
      const duplicate = previousHash !== undefined || sequence <= state.position
      const change = yield* Effect.try(() => projectUpdate(value.notification.update))
      const next: SessionState = { ...state, rows: new Map(state.rows), position: Math.max(state.position, sequence), fingerprints: state.fingerprints }
      const completed: TimelineRow[] = []
      if (change.kind === 'message' || change.kind === 'tool') {
        const kind = change.kind === 'message' ? 'message' : 'tool_call'
        const old = next.rows.get(`${kind}:${change.id}`)
        if (old && old.runId !== null && value.runId !== null && old.runId !== value.runId) return yield* invalid()
        // Persisted snapshots already contain this archive prefix. Replaying an
        // unfinished message with no row creates a new UUID and continues the saved seq.
        if (old && sequence <= old.payload.lastSequence) {
          state.fingerprints.set(sequence, hash)
          return { duplicate: true }
        }
        let data = yield* Effect.try(() => change.apply(old && Object.keys(old.payload.data).length ? old.payload.data : undefined))
        // Archive recovery can reveal a tail received after the last interruption receipt.
        // Reopen that partial buffer rather than persisting each recovered delta separately.
        if (data.incomplete === true) {
          const { incomplete: _incomplete, ...remaining } = data
          data = { ...remaining, ...(kind === 'message' ? { ended: false } : {}) }
        }
        const meta = value.notification.update._meta
        const markedComplete = Predicate.isObject(meta) && meta['folio/messageComplete'] === true
        if (kind === 'message' && (markedComplete || value.notification.update.sessionUpdate === 'user_message')) {
          data = { ...data, ended: true,
            ...(Predicate.isObject(meta) && meta['folio/messageIncomplete'] === true ? { incomplete: true } : {}) }
        }
        const row = { ...(old ?? newRow(next, value.sessionId, value.runId, kind, change.id, sequence)),
          payload: { kind, protocolId: change.id, firstSequence: old?.payload.firstSequence ?? sequence, lastSequence: sequence, data } } satisfies TimelineRow
        next.rows.set(key(row), row)
        if (terminal(row)) completed.push(row)
      } else if (change.kind === 'idle') {
        for (const [id, row] of next.rows) {
          if (row.payload.kind !== 'message' || terminal(row) || row.payload.lastSequence >= sequence) continue
          const complete = value.notification.update.stopReason === 'end_turn'
          const ended = { ...row, payload: { ...row.payload, lastSequence: sequence,
            data: { ...row.payload.data, ended: true, ...(complete ? {} : { incomplete: true }) } } }
          next.rows.set(id, ended)
          completed.push(ended)
        }
      } else if (!duplicate && !next.rows.has(`acp_update:${sequence}`) && value.notification.update.sessionUpdate !== 'state_update') {
        const base = newRow(next, value.sessionId, value.runId, 'acp_update', String(sequence), sequence)
        const row = { ...base, payload: { ...base.payload, data: value.notification.update } }
        next.rows.set(key(row), row)
        completed.push(row)
      }
      // No SQL transaction, cursor update or durable journal write for a streaming delta.
      if (completed.length) yield* persist(completed)
      next.fingerprints.set(sequence, hash)
      sessions.set(value.sessionId, next)
      return { duplicate }
    }, gate.withPermit, Effect.mapError(safeError))

    /** Cancellation/crash cleanup retains received partial output without claiming it completed. */
    const finishSession = Effect.fn('HarnessEventStore.finishSession')(function*(sessionId: string) {
      const state = yield* load(sessionId)
      const next = { ...state, rows: new Map(state.rows) }
      const records: TimelineRow[] = []
      for (const [id, row] of next.rows) {
        if (terminal(row) || !Object.keys(row.payload.data).length) continue
        const ended = { ...row, payload: { ...row.payload, data: { ...row.payload.data,
          ...(row.payload.kind === 'message' ? { ended: true } : {}), incomplete: true } } }
        next.rows.set(id, ended)
        records.push(ended)
      }
      if (records.length) yield* persist(records)
      sessions.set(sessionId, next)
    }, gate.withPermit, Effect.mapError(safeError))

    const rows = (sessionId: string) => load(sessionId).pipe(Effect.map(state => [...state.rows.values()].sort((a, b) => a.seq - b.seq)))
    return HarnessEventStore.of({ appendUpdate, finishSession,
      lastSequence: id => load(id).pipe(Effect.map(state => state.position), gate.withPermit, Effect.mapError(safeError)),
      messages: id => rows(id).pipe(Effect.map(records => records
        .filter(row => row.type === 'message' && Object.keys(row.payload.data).length)),
        gate.withPermit, Effect.mapError(safeError)),
    })
  }))
}
