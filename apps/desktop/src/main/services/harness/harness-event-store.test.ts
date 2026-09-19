import { reserveClaimedRun, finishClaimedRun } from '../testing/claimed-run'
import { Effect, Layer, Schema } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { mkdtemp, rm } from 'node:fs/promises'
import { version as uuidVersion } from 'uuid'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RecordedUpdate } from '../../../shared/harness-events'
import { HarnessEventStore } from './harness-event-store'
import { HarnessStore } from './harness-store'
import { vaultDatabaseLayer } from '../vault/vault-database'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'folio-events-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
/** Fresh connection scopes share only the Vault database on disk. */
function layer() {
  return Layer.mergeAll(HarnessStore.layer, HarnessEventStore.layer).pipe(Layer.provideMerge(vaultDatabaseLayer(root)))
}
/** Builds explicit Folio archive positions; repeated text is not a deduplication key. */
function event(position: number, update: Schema.JsonObject, connectionId = 'first'): RecordedUpdate {
  return { sessionId: 'folio', runId: 'run', connectionId,
    notification: { sessionId: 'acp', _meta: { 'folio/eventSequence': position }, update } }
}
const setup = Effect.gen(function*() {
  const store = yield* HarnessStore
  yield* store.createTask({ id: 'task', goal: 'notes', configuration: { agent: 'pi', skillIds: [], integrationIds: [] }, branch: 'task', worktree: '/worktrees/task' })
  // Storage-only fixture: the real Git resource boundary is covered by TaskWorktrees tests.
  yield* Effect.flatMap(SqlClient.SqlClient, sql => sql`UPDATE tasks SET worktree_state='ready', worktree_base='baseline' WHERE id='task'`)
  yield* store.createSession({ id: 'folio', taskId: 'task', agent: 'pi', adapterVersion: '1', purpose: 'task', syncOperationId: null })
  yield* store.bindSession('folio', { acpSessionId: 'acp', nativeSessionId: 'native' })
  yield* reserveClaimedRun({ id: 'run', taskId: 'task', sessionId: 'folio', prompt: 'notes', purpose: 'execution', resumesRunId: null, baselineCommit: 'base' })
})
const chunk = { sessionUpdate: 'agent_message_chunk', messageId: 'message', content: { type: 'text', text: 'same' } }

describe('Vault ACP events and projection', () => {
  it('serializes duplicate delivery and scopes colliding message IDs to their Folio Session', async () => {
    await Effect.runPromise(Effect.gen(function*() {
      yield* setup
      const store = yield* HarnessEventStore
      const results = yield* Effect.all([store.appendUpdate(event(1, chunk)), store.appendUpdate(event(1, chunk))], { concurrency: 'unbounded' })
      expect(results.map(result => result.duplicate).sort()).toEqual([false, true])
      const harness = yield* HarnessStore
      yield* finishClaimedRun('run', 'succeeded')
      yield* harness.createSession({ id: 'second', taskId: 'task', agent: 'pi', adapterVersion: '1', purpose: 'task', syncOperationId: null })
      yield* harness.bindSession('second', { acpSessionId: 'second-acp', nativeSessionId: 'second-native' })
      const input = event(1, { ...chunk, content: { type: 'text', text: 'separate' } })
      yield* store.appendUpdate({ ...input, sessionId: 'second', runId: null, notification: { ...input.notification, sessionId: 'second-acp' } })
      expect(yield* store.messages('folio')).toMatchObject([{ type: 'message', payload: { data: { content: [chunk.content] } } }])
      expect(yield* store.messages('second')).toMatchObject([{ type: 'message', payload: { data: { content: [{ type: 'text', text: 'separate' }] } } }])
    }).pipe(Effect.provide(layer())))
  })

  it('persists completed messages once and validates replay across restart', async () => {
    const updates = [chunk, chunk, { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' }]
    await Effect.runPromise(Effect.gen(function*() {
      yield* setup
      const store = yield* HarnessEventStore
      for (const [index, update] of updates.entries()) expect(yield* store.appendUpdate(event(index + 1, update))).toEqual({ duplicate: false })
    }).pipe(Effect.provide(layer())))
    await Effect.runPromise(Effect.gen(function*() {
      const store = yield* HarnessEventStore
      for (const [index, update] of updates.entries()) {
        expect(yield* store.appendUpdate({ ...event(index + 1, update, 'reconnected'), runId: null })).toEqual({ duplicate: true })
      }
      const messages = yield* store.messages('folio')
      expect(messages).toMatchObject([{ runId: 'run', sessionId: 'folio', seq: 1, type: 'message', payload: { firstSequence: 1, lastSequence: 3, data: {
        role: 'assistant', content: [chunk.content, chunk.content], ended: true
      } } }])
      const sql = yield* SqlClient.SqlClient
      expect(yield* sql`SELECT count(*) AS count FROM messages WHERE json_extract(payload, '$.kind')='protocol'`).toEqual([{ count: 0 }])
      expect(yield* sql`SELECT count(*) AS count FROM messages WHERE json_extract(payload, '$.kind')='acp_update'`).toEqual([{ count: 0 }])
      expect(uuidVersion(messages[0]!.id)).toBe(7)
      expect(messages[0]).toHaveProperty('timestamp', expect.any(Number))
      expect(messages[0]).not.toHaveProperty('data')
      expect(messages[0]).not.toHaveProperty('firstSequence')
      expect(yield* store.messages('folio')).toEqual(messages)
      // Foreground idle does not imply that scripts have exited, files are committed, or the Run is finalized.
      const harness = yield* HarnessStore
      expect(yield* harness.runs('task')).toMatchObject([{ state: 'preparing' }])
    }).pipe(Effect.provide(layer())))
  })

  it('applies omitted/null/replacement content and tool patch semantics without losing opaque data', async () => {
    await Effect.runPromise(Effect.gen(function*() {
      yield* setup
      const store = yield* HarnessEventStore
      const updates: Schema.JsonObject[] = [
        chunk,
        { sessionUpdate: 'agent_message', messageId: 'message', content: [{ type: 'text', text: 'final' }], _meta: { label: 'kept' } },
        { sessionUpdate: 'agent_message', messageId: 'message' },
        { sessionUpdate: 'tool_call_update', toolCallId: 'tool', title: 'Command', rawInput: { command: 'echo hello' } },
        { sessionUpdate: 'tool_call_content_chunk', toolCallId: 'tool', content: { type: 'content', content: { type: 'text', text: 'partial' } } },
        { sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'full output' } }] },
        { sessionUpdate: '_future', opaque: { retained: [1, 2, 3] } }
      ]
      for (const [index, update] of updates.entries()) yield* store.appendUpdate(event(index + 1, update))
      expect((yield* store.messages('folio')).filter(row => row.payload.kind === 'message')).toMatchObject([{ type: 'message', payload: { data: { content: [{ type: 'text', text: 'final' }], metadata: { label: 'kept' }, ended: false } } }])
      expect((yield* store.messages('folio')).filter(row => row.payload.kind === 'tool_call')).toMatchObject([{ type: 'message', payload: { data: { title: 'Command', rawInput: { command: 'echo hello' }, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'full output' } }] } } }])
      yield* store.appendUpdate(event(8, { sessionUpdate: 'agent_message', messageId: 'message', content: null, _meta: null }))
      yield* store.appendUpdate(event(9, { sessionUpdate: 'tool_call_update', toolCallId: 'tool', content: null, title: null }))
      expect((yield* store.messages('folio')).filter(row => row.payload.kind === 'message')).toMatchObject([{ type: 'message', payload: { data: { content: [], metadata: null } } }])
      expect((yield* store.messages('folio')).filter(row => row.payload.kind === 'tool_call')).toMatchObject([{ type: 'message', payload: { data: { content: null, title: null, status: 'completed' } } }])
      const sql = yield* SqlClient.SqlClient
      expect(yield* sql`SELECT type FROM messages WHERE json_extract(payload, '$.kind')='tool_call'`).toEqual([{ type: 'message' }])
      expect(yield* sql`SELECT type FROM messages WHERE json_extract(payload, '$.kind')='acp_update'`).toEqual([{ type: 'custom' }])
      const raw = yield* sql`SELECT json_extract(payload, '$.data') AS payload FROM messages WHERE json_extract(payload, '$.kind')='acp_update' AND json_extract(payload, '$.firstSequence')=7`
      expect(raw).toEqual([{ payload: JSON.stringify(updates[6]) }])
    }).pipe(Effect.provide(layer())))
  })

  it('rejects gaps, mutated replay, wrong Session binding and malformed known updates atomically', async () => {
    await Effect.runPromise(Effect.gen(function*() {
      yield* setup
      const store = yield* HarnessEventStore
      expect(yield* store.appendUpdate(event(2, chunk)).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      yield* store.appendUpdate(event(1, chunk))
      expect(yield* store.appendUpdate(event(1, { ...chunk, content: { type: 'text', text: 'changed' } })).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      const wrong = event(2, chunk)
      expect(yield* store.appendUpdate({ ...wrong, notification: { ...wrong.notification, sessionId: 'other-acp' } }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      expect(yield* store.appendUpdate(event(2, { sessionUpdate: 'agent_message_chunk', messageId: 'broken', content: 12 })).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
      const sql = yield* SqlClient.SqlClient
      expect(yield* sql`SELECT count(*) AS count FROM messages WHERE json_extract(payload, '$.kind')='acp_update'`).toEqual([{ count: 0 }])
      expect(yield* store.messages('folio')).toMatchObject([{ type: 'message', payload: { data: { content: [chunk.content] } } }])
      yield* store.appendUpdate(event(2, chunk))
    }).pipe(Effect.provide(layer())))
  })

  it('retains the buffer when completed-message persistence fails and retries once', async () => {
    await Effect.runPromise(Effect.gen(function*() {
      yield* setup
      const store = yield* HarnessEventStore
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TRIGGER reject_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`
      yield* store.appendUpdate(event(1, chunk))
      const completed = { sessionUpdate: 'agent_message', messageId: 'message', _meta: { 'folio/messageComplete': true } }
      expect(yield* store.appendUpdate(event(2, completed)).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
      expect(yield* store.lastSequence('folio')).toBe(1)
      expect(yield* sql`SELECT count(*) AS count FROM messages WHERE json_extract(payload, '$.kind')='acp_update'`).toEqual([{ count: 0 }])
      yield* sql`DROP TRIGGER reject_message`
      yield* store.appendUpdate(event(2, completed))
      expect(yield* store.messages('folio')).toHaveLength(1)
    }).pipe(Effect.provide(layer())))
  })
  it('recovers unfinished content from the archive using only saved messages and continues their seq', async () => {
    const first = event(1, chunk)
    const other = event(2, { ...chunk, messageId: 'other', content: { type: 'text', text: 'other' } })
    const otherDone = event(3, { sessionUpdate: 'agent_message', messageId: 'other', _meta: { 'folio/messageComplete': true } })
    let ids: string[] = []
    await Effect.runPromise(Effect.gen(function*() {
      yield* setup
      const store = yield* HarnessEventStore
      for (const value of [first, other, otherDone]) yield* store.appendUpdate(value)
      ids = (yield* store.messages('folio')).map(row => row.id)
      const sql = yield* SqlClient.SqlClient
      expect(yield* sql`SELECT seq, type FROM messages`).toEqual([{ seq: 2, type: 'message' }])
      expect(yield* sql`SELECT name FROM sqlite_master WHERE type='table' AND name='message_checkpoints'`).toEqual([])
      expect(yield* sql`PRAGMA table_info(messages)`).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'id' }), expect.objectContaining({ name: 'session_id' }),
        expect.objectContaining({ name: 'run_id' }), expect.objectContaining({ name: 'seq' }),
        expect.objectContaining({ name: 'type' }), expect.objectContaining({ name: 'timestamp' }),
        expect.objectContaining({ name: 'payload' })
      ]))
    }).pipe(Effect.provide(layer())))
    await Effect.runPromise(Effect.gen(function*() {
      const store = yield* HarnessEventStore
      for (const value of [first, other, otherDone]) expect(yield* store.appendUpdate(value)).toEqual({ duplicate: true })
      yield* store.appendUpdate(event(4, chunk))
      yield* store.appendUpdate(event(5, { sessionUpdate: 'agent_message', messageId: 'message', _meta: { 'folio/messageComplete': true } }))
      const messages = yield* store.messages('folio')
      expect(messages[0]!.id).toBe(ids[1])
      expect(messages[1]!.id).not.toBe(ids[0])
      expect(uuidVersion(messages[1]!.id)).toBe(7)
      expect(messages[1]!.payload.data.content).toEqual([chunk.content, chunk.content])
      const sql = yield* SqlClient.SqlClient
      expect(yield* sql`SELECT seq, type FROM messages ORDER BY seq`).toEqual([{ seq: 2, type: 'message' }, { seq: 3, type: 'message' }])
    }).pipe(Effect.provide(layer())))
  })

  it('saves partial text on cancellation once and never persists wire chunks', async () => {
    await Effect.runPromise(Effect.gen(function*() {
      yield* setup
      const store = yield* HarnessEventStore
      const sql = yield* SqlClient.SqlClient
      yield* store.appendUpdate(event(1, chunk))
      expect(yield* sql`SELECT id FROM messages`).toEqual([])
      yield* store.finishSession('folio')
      const writes = yield* sql`SELECT total_changes() AS count`
      yield* store.finishSession('folio')
      expect(yield* sql`SELECT total_changes() AS count`).toEqual(writes)
      expect(yield* store.messages('folio')).toMatchObject([{ type: 'message', payload: { data: { content: [chunk.content], ended: true, incomplete: true } } }])
    }).pipe(Effect.provide(layer())))
    await Effect.runPromise(Effect.gen(function*() {
      expect(yield* (yield* HarnessEventStore).messages('folio')).toMatchObject([{ type: 'message', payload: { data: { incomplete: true } } }])
    }).pipe(Effect.provide(layer())))
  })

  it('keeps an interrupted message incomplete even if the SDK later recovers the turn', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      yield* setup
      const store = yield* HarnessEventStore
      yield* store.appendUpdate(event(1, chunk))
      yield* store.appendUpdate(event(2, { sessionUpdate: 'agent_message', messageId: 'message',
        _meta: { 'folio/messageComplete': true, 'folio/messageIncomplete': true } }))
      yield* store.appendUpdate(event(3, { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' }))
      yield* store.finishSession('folio')
      expect(yield* store.messages('folio')).toMatchObject([{ payload: { data: { ended: true, incomplete: true, content: [chunk.content] } } }])
      const sql = yield* SqlClient.SqlClient
      expect(yield* sql`SELECT json_extract(payload, '$.data.incomplete') AS incomplete FROM messages`).toEqual([{ incomplete: 1 }])
    }).pipe(Effect.provide(layer())))
  })

})
