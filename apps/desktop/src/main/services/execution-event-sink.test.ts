import { Effect, Layer, ManagedRuntime } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ExecutionEventSink } from './execution-event-sink'
import type { RecordedUpdate } from '../../shared/harness-events'
import { RunFiles, fileEffect } from './run-files'
import { ExecutionQueue } from './execution-queue'
import { HarnessStore } from './harness-store'
import { HarnessEventStore } from './harness-event-store'
import { VaultContext } from './vault-context'
import { vaultDatabaseLayer } from './vault-database'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'folio-vault-subscriber-')); await mkdir(join(root, 'a')); await mkdir(join(root, 'b')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const vaultLayer = (id = 'a') => ExecutionEventSink.layer.pipe(
  Layer.provideMerge(RunFiles.layer),
  Layer.provideMerge(Layer.mergeAll(HarnessStore.layer, HarnessEventStore.layer, ExecutionQueue.layer)),
  Layer.provideMerge(vaultDatabaseLayer(join(root, id))),
  Layer.provide(Layer.succeed(VaultContext)({ id, directory: join(root, id), vault: { id, name: id, path: join(root, id) } }))
)
const setup = Effect.gen(function* () {
  const store = yield* HarnessStore
  yield* store.createTask({ id: 'task', goal: 'notes', branch: 'task', worktree: '/worktrees/task', configuration: { agent: 'codex', skillIds: [], integrationIds: [] } })
  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE tasks SET worktree_state='ready' WHERE id='task'`
  yield* store.createSession({ id: 'session', taskId: 'task', agent: 'codex', adapterVersion: '1', purpose: 'task', syncOperationId: null })
  const queue = yield* ExecutionQueue
  yield* queue.submit({ id: 'run', taskId: 'task', sessionId: 'session', prompt: 'notes', purpose: 'execution', resumesRunId: null, source: 'manual' })
  const run = yield* queue.claim('attempt')
  yield* (yield* ExecutionEventSink).begin(run!)
})
const update = (sequence: number, text: string): RecordedUpdate => ({
  sessionId: 'session', runId: 'run', connectionId: 'connection', notification: { sessionId: 'acp',
    _meta: { 'folio/eventSequence': sequence },
    update: { sessionUpdate: 'agent_message_chunk', messageId: 'message', content: { type: 'text', text } }
  }
})

it('streams through the real sink without writing SQL or recovery files, then persists completion', async () => {
  let vault = ManagedRuntime.make(vaultLayer())
  try {
    await vault.runPromise(setup)
    await vault.runPromise(Effect.gen(function* () {
      const sink = yield* ExecutionEventSink
      yield* sink.bindSession('session', { acpSessionId: 'acp', nativeSessionId: 'native' })
      yield* sink.reserveRun({ id: 'run', taskId: 'task', sessionId: 'session', prompt: 'notes', purpose: 'execution', resumesRunId: null, baselineCommit: 'base' })
      const sql = yield* SqlClient.SqlClient
      yield* sink.flush
      const logPath = join(root, 'a', 'logs/runs/run/attempt.jsonl')
      const logBefore = yield* Effect.promise(() => readFile(logPath, 'utf8'))
      const before = yield* sql`SELECT total_changes() AS count`
      const files = yield* RunFiles
      const state = yield* fileEffect(() => files.read('run', 'attempt'))
      for (let sequence = 1; sequence <= 100; sequence++) yield* sink.appendUpdate(update(sequence, 'x'))
      expect(yield* sql`SELECT total_changes() AS count`).toEqual(before)
      expect(yield* sql`SELECT id FROM messages`).toEqual([])
      yield* sink.flush
      expect(yield* Effect.promise(() => readFile(logPath, 'utf8'))).toBe(logBefore)
      expect(yield* fileEffect(() => files.read('run', 'attempt'))).toEqual(state)
      const messages = yield* (yield* HarnessEventStore).messages('session')
      expect(messages[0]!.payload.data.content).toHaveLength(100)
      const done = { ...update(101, ''), notification: { ...update(101, '').notification,
        update: { sessionUpdate: 'agent_message', messageId: 'message', _meta: { 'folio/messageComplete': true } } } }
      yield* sql`CREATE TRIGGER fail_projection BEFORE INSERT ON messages
        BEGIN SELECT RAISE(ABORT, 'injected projection failure'); END`
      expect(yield* sink.appendUpdate(done).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
      yield* sql`DROP TRIGGER fail_projection`
      yield* sink.appendUpdate(done)
      expect(yield* sql`SELECT count(*) AS count FROM messages`).toEqual([{ count: 1 }])
      expect(yield* fileEffect(() => files.read('run', 'attempt'))).toEqual(state)
      yield* sink.markRunning('run')
      yield* sink.finishRun('run', 'succeeded')
      yield* sink.finishRequest(yield* (yield* ExecutionQueue).get('run'), 'failed')
    }))
    await vault.dispose()
    vault = ManagedRuntime.make(vaultLayer())
    await vault.runPromise(Effect.gen(function* () {
      const messages = yield* (yield* HarnessEventStore).messages('session')
      expect(messages[0]!.payload.data.content).toHaveLength(100)
      expect(messages[0]!.payload.data.ended).toBe(true)
      expect(yield* (yield* HarnessStore).runs('task')).toMatchObject([{ state: 'succeeded' }])
    }))
  } finally { await vault.dispose() }
})

it('retains ownership until every native process and Worker has a cleanup receipt', async () => {
  const vault = ManagedRuntime.make(vaultLayer())
  try {
    await vault.runPromise(setup)
    await vault.runPromise(Effect.gen(function* () {
      const sink = yield* ExecutionEventSink
      const queue = yield* ExecutionQueue
      const run = yield* queue.get('run')
      yield* sink.bindSession('session', { acpSessionId: 'acp', nativeSessionId: 'native' })
      yield* sink.reserveRun({ id: 'run', taskId: 'task', sessionId: 'session', prompt: 'notes', purpose: 'execution', resumesRunId: null, baselineCommit: 'base' })
      yield* sink.markRunning('run')
      yield* sink.workerStarted('session', 1)
      yield* sink.processStarted('session', 101)
      yield* sink.processStarted('session', 102)
      yield* sink.processStopped('session', 101)
      yield* sink.finishRun('run', 'succeeded')
      expect(yield* sink.finishRequest(run, 'failed').pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      expect(yield* queue.get('run')).toMatchObject({ state: 'running', endedAt: null })
      yield* sink.processStopped('session', 102)
      yield* sink.workerStopped('session')
      // A late cancellation cannot erase an already confirmed successful result.
      yield* queue.cancel('run')
      yield* sink.finishRequest(run, 'cancelled')
      expect(yield* queue.get('run')).toMatchObject({ state: 'succeeded' })
      const files = yield* RunFiles
      expect(yield* fileEffect(() => files.read('run', 'attempt'))).toBeNull()
    }))
  } finally { await vault.dispose() }
})

it('keeps the result file when the terminal transaction fails and retries without an Agent', async () => {
  const vault = ManagedRuntime.make(vaultLayer())
  try {
    await vault.runPromise(setup)
    await vault.runPromise(Effect.gen(function* () {
      const sink = yield* ExecutionEventSink
      const queue = yield* ExecutionQueue
      const files = yield* RunFiles
      const sql = yield* SqlClient.SqlClient
      const run = yield* queue.get('run')
      yield* sink.finishRun('run', 'failed', 'preparation failed')
      yield* sql`CREATE TRIGGER fail_terminal BEFORE UPDATE OF state ON runs
        WHEN NEW.state='failed' BEGIN SELECT RAISE(ABORT, 'injected commit failure'); END`
      expect(yield* sink.finishRequest(run, 'interrupted').pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
      expect(yield* fileEffect(() => files.read('run', 'attempt'))).toMatchObject({ result: { outcome: 'failed' } })
      expect((yield* queue.get('run')).endedAt).toBeNull()
      yield* sql`DROP TRIGGER fail_terminal`
      yield* sink.finishRequest(run, 'interrupted')
      expect(yield* queue.get('run')).toMatchObject({ state: 'failed', error: 'preparation failed' })
    }))
  } finally { await vault.dispose() }
})

it('rejects delayed callbacks from a superseded execution owner', async () => {
  const vault = ManagedRuntime.make(vaultLayer())
  try {
    await vault.runPromise(setup)
    await vault.runPromise(Effect.gen(function* () {
      const sink = yield* ExecutionEventSink
      const guard = yield* sink.guard('session')
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE runs SET owner='replacement' WHERE id='run'`
      expect(yield* guard(sink.processStarted('session', 101)).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      const files = yield* RunFiles
      expect(yield* fileEffect(() => files.read('run', 'attempt'))).toMatchObject({ processes: [] })
    }))
  } finally { await vault.dispose() }
})
