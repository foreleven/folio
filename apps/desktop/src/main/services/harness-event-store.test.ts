import { Effect, Layer, Schema } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RecordedUpdate } from '../../shared/harness-events'
import { HarnessEventStore } from './harness-event-store'
import { HarnessStore } from './harness-store'
import { vaultDatabaseLayer } from './vault-database'

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
  yield* store.reserveRun({ id: 'run', taskId: 'task', sessionId: 'folio', prompt: 'notes', purpose: 'execution', resumesRunId: null, baselineCommit: 'base' })
})
const chunk = { sessionUpdate: 'agent_message_chunk', messageId: 'message', content: { type: 'text', text: 'same' } }

describe('Vault ACP events and projection', () => {
  it('persists bounded malformed-wire diagnostics without retaining raw bytes', async () => {
    await Effect.runPromise(Effect.gen(function*() {
      yield* setup
      const store = yield* HarnessEventStore
      yield* store.appendProtocolDiagnostic({
        sessionId: 'folio', connectionId: 'connection', direction: 'inbound',
        diagnostic: { reason: 'invalid-utf8', byteLength: 4, sha256: 'a'.repeat(64) }
      })
      expect(yield* store.diagnostics('folio')).toMatchObject([{
        sessionId: 'folio', connectionId: 'connection', direction: 'inbound',
        reason: 'invalid-utf8', byteLength: 4, sha256: 'a'.repeat(64)
      }])
      const sql = yield* SqlClient.SqlClient
      expect(yield* sql`SELECT name FROM sqlite_master WHERE type='table' AND name='messages'`).toEqual([{ name: 'messages' }])
      expect(yield* Effect.exit(store.appendProtocolDiagnostic({
        sessionId: 'missing', connectionId: 'connection', direction: 'inbound',
        diagnostic: { reason: 'invalid-json', byteLength: 1, sha256: 'b'.repeat(64) }
      }))).toMatchObject({ _tag: 'Failure' })
    }).pipe(Effect.provide(layer())))
  })

  it('persists pre-binding wire frames across reopen and rejects cross-session attribution atomically', async () => {
    await Effect.runPromise(Effect.gen(function*() {
      yield* setup
      const harness = yield* HarnessStore
      yield* harness.finishRun('run', 'succeeded')
      yield* harness.createSession({ id: 'unbound', taskId: 'task', agent: 'pi', adapterVersion: '1', purpose: 'task', syncOperationId: null })
      const store = yield* HarnessEventStore
      const frame = { sessionId: 'unbound', connectionId: 'connection', direction: 'outbound' as const,
        payload: [{ jsonrpc: '2.0', id: 1, method: 'initialize' }],
        associations: [{ kind: 'request' as const, requestId: 1, method: 'initialize', runId: null }] }
      yield* store.appendProtocol(frame)
      expect(yield* Effect.exit(store.appendProtocol({ ...frame, associations: [
        ...frame.associations, { kind: 'request', requestId: 2, method: 'session/prompt', runId: 'run' }
      ] }))).toMatchObject({ _tag: 'Failure' })
      expect(yield* store.protocol('unbound')).toMatchObject([frame])
      expect(yield* store.messages('unbound')).toEqual([])
    }).pipe(Effect.provide(layer())))
    await Effect.runPromise(Effect.gen(function*() {
      const store = yield* HarnessEventStore
      expect(yield* store.protocol('unbound')).toMatchObject([{ connectionId: 'connection',
        payload: [{ jsonrpc: '2.0', id: 1, method: 'initialize' }],
        associations: [{ kind: 'request', requestId: 1, method: 'initialize', runId: null }] }])
    }).pipe(Effect.provide(layer())))
  })

  it('serializes duplicate delivery and scopes colliding message IDs to their Folio Session', async () => {
    await Effect.runPromise(Effect.gen(function*() {
      yield* setup
      const store = yield* HarnessEventStore
      const results = yield* Effect.all([store.appendUpdate(event(1, chunk)), store.appendUpdate(event(1, chunk))], { concurrency: 'unbounded' })
      expect(results.map(result => result.duplicate).sort()).toEqual([false, true])
      const harness = yield* HarnessStore
      yield* harness.finishRun('run', 'succeeded')
      yield* harness.createSession({ id: 'second', taskId: 'task', agent: 'pi', adapterVersion: '1', purpose: 'task', syncOperationId: null })
      yield* harness.bindSession('second', { acpSessionId: 'second-acp', nativeSessionId: 'second-native' })
      const input = event(1, { ...chunk, content: { type: 'text', text: 'separate' } })
      yield* store.appendUpdate({ ...input, sessionId: 'second', runId: null, notification: { ...input.notification, sessionId: 'second-acp' } })
      expect(yield* store.messages('folio')).toMatchObject([{ data: { content: [chunk.content] } }])
      expect(yield* store.messages('second')).toMatchObject([{ data: { content: [{ type: 'text', text: 'separate' }] } }])
    }).pipe(Effect.provide(layer())))
  })

  it('retains every replay receipt while projecting immutable positions once across restart and rebuild', async () => {
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
      expect(messages).toMatchObject([{ runId: 'run', firstSequence: 1, lastSequence: 3, data: {
        role: 'assistant', content: [chunk.content, chunk.content], ended: true
      } }])
      const sql = yield* SqlClient.SqlClient
      expect(yield* sql`SELECT count(*) AS count FROM messages WHERE kind='protocol'`).toEqual([{ count: 0 }])
      expect(yield* sql`SELECT count(*) AS count FROM messages WHERE kind='acp_update'`).toEqual([{ count: 3 }])
      yield* store.rebuild('folio')
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
      expect((yield* store.messages('folio')).filter(row => row.kind === 'message')).toMatchObject([{ data: { content: [{ type: 'text', text: 'final' }], metadata: { label: 'kept' }, ended: false } }])
      expect((yield* store.messages('folio')).filter(row => row.kind === 'tool_call')).toMatchObject([{ data: { title: 'Command', rawInput: { command: 'echo hello' }, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'full output' } }] } }])
      yield* store.appendUpdate(event(8, { sessionUpdate: 'agent_message', messageId: 'message', content: null, _meta: null }))
      yield* store.appendUpdate(event(9, { sessionUpdate: 'tool_call_update', toolCallId: 'tool', content: null, title: null }))
      expect((yield* store.messages('folio')).filter(row => row.kind === 'message')).toMatchObject([{ data: { content: [], metadata: null } }])
      expect((yield* store.messages('folio')).filter(row => row.kind === 'tool_call')).toMatchObject([{ data: { content: null, title: null, status: 'completed' } }])
      const sql = yield* SqlClient.SqlClient
      const raw = yield* sql`SELECT data AS payload FROM messages WHERE kind='acp_update' AND source_sequence=7`
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
      expect(yield* sql`SELECT count(*) AS count FROM messages WHERE kind='acp_update'`).toEqual([{ count: 1 }])
      expect(yield* store.messages('folio')).toMatchObject([{ data: { content: [chunk.content] } }])
      yield* store.appendUpdate(event(2, chunk))
    }).pipe(Effect.provide(layer())))
  })

  it('rolls back raw writes when the projection cannot commit', async () => {
    await Effect.runPromise(Effect.gen(function*() {
      yield* setup
      const store = yield* HarnessEventStore
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TRIGGER reject_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`
      expect(yield* store.appendUpdate(event(1, chunk)).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
      expect(yield* sql`SELECT count(*) AS count FROM messages WHERE kind='acp_update'`).toEqual([{ count: 0 }])
      yield* sql`DROP TRIGGER reject_message`
      yield* store.appendUpdate(event(1, chunk))
      expect(yield* store.messages('folio')).toHaveLength(1)
    }).pipe(Effect.provide(layer())))
  })
})
