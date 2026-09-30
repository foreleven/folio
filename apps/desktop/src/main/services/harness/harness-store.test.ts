import { reserveClaimedRun, markClaimedRunning, finishClaimedRun } from '../testing/claimed-run'
import { Effect, Layer } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExecutionQueue } from '../execution/execution-queue'
import { HarnessStore } from './harness-store'
import { vaultDatabaseLayer } from '../vault/vault-database'
import { emptyTaskCounts, type IngestionReceipt, type NewRun } from '../../../shared/harness'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'folio-harness-store-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
/** Rebuild layers for every invocation to verify disk persistence rather than shared in-memory objects. */
function layer(directory = root) {
  return Layer.merge(HarnessStore.layer(directory), ExecutionQueue.layer).pipe(Layer.provideMerge(vaultDatabaseLayer(directory)))
}
/** Supplies three deliberately distinct identities for a bound Session. */
const setup = Effect.gen(function* () {
  const store = yield* HarnessStore
  yield* store.createTask({
    id: 'task',
    type: 'agent', receipt: null,
    configuration: { goal: 'Summarize notes', agent: 'pi', model: null, skillIds: ['notes'], integrationIds: ['lark'], resourceIds: [], rawInput: null }
  })
  // Storage-only fixture: the real Git resource boundary is covered by TaskWorktrees tests.
  yield* Effect.flatMap(SqlClient.SqlClient, (sql) => sql`UPDATE tasks SET worktree_state='ready', worktree_base='baseline' WHERE id='task'`)
  yield* store.createSession({ id: 'folio-session', taskId: 'task', agent: 'pi', adapterVersion: '1', purpose: 'task', syncOperationId: null })
  yield* store.bindSession('folio-session', { acpSessionId: 'acp-session', nativeSessionId: 'native-session' })
})
const run: NewRun = { id: 'run', taskId: 'task', sessionId: 'folio-session', prompt: 'Read the notes', purpose: 'execution', resumesRunId: null, baselineCommit: 'baseline' }

describe('Vault harness execution ledger', () => {
  it('counts current Tasks and clears historical interruption after retry and completion', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* HarnessStore
      expect(yield* store.taskCounts).toEqual(emptyTaskCounts())
      yield* setup
      expect(yield* store.taskCounts).toEqual({ ...emptyTaskCounts(), pending: 1 })
      yield* reserveClaimedRun(run)
      yield* finishClaimedRun('run', 'interrupted', 'Execution ownership was lost')
      expect(yield* store.taskCounts).toEqual({ ...emptyTaskCounts(), interrupted: 1 })
      yield* reserveClaimedRun({ ...run, id: 'recovery', purpose: 'recovery', resumesRunId: 'run' })
      yield* finishClaimedRun('recovery', 'succeeded')
      // A successful turn still awaits publication or explicit Task completion.
      expect(yield* store.taskCounts).toEqual({ ...emptyTaskCounts(), pending: 1 })
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE tasks SET state='completed' WHERE id='task'`
      expect(yield* store.taskCounts).toEqual({ ...emptyTaskCounts(), completed: 1 })
      const queue = yield* ExecutionQueue
      expect(yield* queue.counts).toMatchObject({ interrupted: 1, succeeded: 1 })
    }).pipe(Effect.provide(layer())))
  })

  it('counts queued follow-ups once and keeps a live worker ahead of newer queued or cancelled Runs', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      yield* setup
      const store = yield* HarnessStore
      const queue = yield* ExecutionQueue
      for (const id of ['first', 'second', 'third']) yield* queue.submit({ ...run, id, source: 'manual' })
      expect(yield* store.taskCounts).toEqual({ ...emptyTaskCounts(), queued: 1 })
      const claimed = (yield* queue.claim('worker'))!
      expect(yield* store.taskCounts).toEqual({ ...emptyTaskCounts(), preparing: 1 })
      yield* store.reserveRun({ ...run, id: claimed.id }, claimed.owner!)
      yield* queue.running(claimed.id, claimed.owner!)
      yield* queue.cancel('third')
      expect(yield* store.taskCounts).toEqual({ ...emptyTaskCounts(), running: 1 })
      yield* queue.finish(claimed.id, claimed.owner!, 'failed')
      expect(yield* store.taskCounts).toEqual({ ...emptyTaskCounts(), queued: 1 })
      yield* queue.cancel('second')
      expect(yield* store.taskCounts).toEqual({ ...emptyTaskCounts(), cancelled: 1 })
    }).pipe(Effect.provide(layer())))
  })

  it('includes Ingestion receipts without Runs and honors terminal Task lifecycle', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* HarnessStore
      const sql = yield* SqlClient.SqlClient
      const states: IngestionReceipt['state'][] = ['pending', 'running', 'succeeded', 'failed', 'interrupted', 'cancelled', 'conflict']
      for (const state of states) {
        yield* store.createTask({ id: state, type: 'ingestion', configuration: { integrationId: 'lark', resourceId: 'im' },
          receipt: { state, attemptCount: 1, cancelRequested: false, startedAt: 1, endedAt: null,
            error: null, changeId: null, observedHead: null } })
      }
      yield* sql`UPDATE tasks SET state='completed' WHERE id='succeeded'`
      expect(yield* store.taskCounts).toEqual({ ...emptyTaskCounts(), pending: 1, running: 1, completed: 1,
        failed: 1, interrupted: 1, cancelled: 1, conflict: 1 })
      // Lifecycle wins even when an old receipt still contains a failed attempt.
      yield* sql`UPDATE tasks SET state='completed' WHERE id='failed'`
      yield* sql`UPDATE tasks SET state='cancelled' WHERE id='interrupted'`
      expect(yield* store.taskCounts).toEqual({ ...emptyTaskCounts(), pending: 1, running: 1, completed: 2, cancelled: 2, conflict: 1 })
      yield* sql`UPDATE tasks SET state='active' WHERE id='succeeded'`
      expect(yield* store.taskCounts).toMatchObject({ completed: 1, pending: 2 })
      expect(yield* sql`SELECT id FROM runs`).toEqual([])
      yield* sql`DROP TABLE runs`
      expect(yield* store.taskCounts.pipe(Effect.flip)).toMatchObject({ _tag: 'HarnessStoreError', reason: 'storage' })
    }).pipe(Effect.provide(layer())))
  })

  it('shows Wiki conflicts and counts their repair worker as the same Task', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      yield* setup
      yield* reserveClaimedRun(run)
      yield* finishClaimedRun('run', 'succeeded')
      const store = yield* HarnessStore
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO git_operations (id, task_id, kind, state, source_commit, created_at, updated_at)
        VALUES ('publication', 'task', 'synchronize', 'conflict', 'source', 1, 1)`
      expect(yield* store.taskCounts).toEqual({ ...emptyTaskCounts(), conflict: 1 })
      yield* store.createSession({ id: 'repair', taskId: 'task', agent: 'pi', adapterVersion: '1',
        purpose: 'conflict-resolution', syncOperationId: 'publication' })
      const queue = yield* ExecutionQueue
      yield* queue.submit({ ...run, id: 'repair-run', sessionId: 'repair', purpose: 'conflict-resolution', source: 'conflict-resolution' })
      expect(yield* store.taskCounts).toEqual({ ...emptyTaskCounts(), queued: 1 })
      const claimed = (yield* queue.claim('repair-worker'))!
      expect(yield* store.taskCounts).toEqual({ ...emptyTaskCounts(), preparing: 1 })
      yield* queue.finish(claimed.id, claimed.owner!, 'failed')
      expect(yield* store.taskCounts).toEqual({ ...emptyTaskCounts(), conflict: 1 })
    }).pipe(Effect.provide(layer())))
  })

  it('persists independent IDs, snapshots and uncertain Runs without replay or automatic completion', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setup
        yield* reserveClaimedRun(run)
      }).pipe(Effect.provide(layer()))
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* HarnessStore
        expect(yield* store.task('task')).toMatchObject({ state: 'active', configuration: { skillIds: ['notes'] } })
        expect(yield* store.sessions('task')).toMatchObject([{ id: 'folio-session', acpSessionId: 'acp-session', nativeSessionId: 'native-session' }])
        expect(yield* store.runs('task')).toMatchObject([{ id: 'run', state: 'preparing', endedAt: null }])
        yield* finishClaimedRun('run', 'interrupted', 'Execution ownership was lost')
        yield* reserveClaimedRun({ ...run, id: 'recovery', prompt: 'Inspect existing progress before continuing', purpose: 'recovery', resumesRunId: 'run' })
        yield* markClaimedRunning('recovery')
        yield* finishClaimedRun('recovery', 'succeeded')
        expect(yield* store.task('task')).toMatchObject({ state: 'active' })
        const history = yield* store.runs('task')
        expect(history.find((row) => row.id === 'run')).toMatchObject({ prompt: 'Read the notes', state: 'interrupted' })
        expect(history.find((row) => row.id === 'recovery')).toMatchObject({ state: 'succeeded', syncState: 'pending', resumesRunId: 'run' })
        expect(yield* finishClaimedRun('run', 'succeeded').pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      }).pipe(Effect.provide(layer()))
    )
  })

  it('serializes competing Run reservations across Sessions and permits independent Tasks', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setup
        const store = yield* HarnessStore
        yield* store.createSession({ id: 'second', taskId: 'task', agent: 'pi', adapterVersion: '1', purpose: 'task', syncOperationId: null })
        yield* store.bindSession('second', { acpSessionId: 'second-acp', nativeSessionId: null })
        const outcomes = yield* Effect.all([reserveClaimedRun(run).pipe(Effect.result), reserveClaimedRun({ ...run, id: 'other-run', sessionId: 'second' }).pipe(Effect.result)], {
          concurrency: 'unbounded'
        })
        expect(outcomes.filter((result) => result._tag === 'Success')).toHaveLength(1)
        expect(yield* store.runs('task')).toHaveLength(1)
        expect(yield* store.createSession({ id: 'third', taskId: 'task', agent: 'pi', adapterVersion: '1', purpose: 'task', syncOperationId: null }).pipe(Effect.flip)).toMatchObject({ reason: 'task-busy' })
        yield* store.createTask({
          id: 'other',
          type: 'agent', receipt: null,
          configuration: { goal: 'Other', agent: 'pi', model: null, skillIds: [], integrationIds: [], resourceIds: [], rawInput: null }
        })
        // Storage-only fixture: the real Git resource boundary is covered by TaskWorktrees tests.
        yield* Effect.flatMap(SqlClient.SqlClient, (sql) => sql`UPDATE tasks SET worktree_state='ready', worktree_base='baseline' WHERE id='other'`)
        yield* store.createSession({ id: 'other-session', taskId: 'other', agent: 'pi', adapterVersion: '1', purpose: 'task', syncOperationId: null })
        yield* store.bindSession('other-session', { acpSessionId: 'other-acp', nativeSessionId: null })
        expect(yield* reserveClaimedRun({ ...run, id: 'wrong-task', taskId: 'other' }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
        yield* reserveClaimedRun({ ...run, id: 'independent', taskId: 'other', sessionId: 'other-session' })
        expect(yield* store.runs('other')).toHaveLength(1)
        const sql = yield* SqlClient.SqlClient
        expect(
          yield* sql`INSERT INTO runs (id, task_id, session_id, prompt, purpose, baseline_commit, state, sync_state, created_at)
        VALUES ('bypass', 'other', 'other-session', 'duplicate', 'execution', 'baseline', 'running', 'pending', 0)`.pipe(Effect.flip)
        ).toMatchObject({ _tag: 'SqlError' })
      }).pipe(Effect.provide(layer()))
    )
  })

  it('refuses native rebinding, fixed-Agent violations and recovery through another Session', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setup
        const store = yield* HarnessStore
        yield* store.bindSession('folio-session', { acpSessionId: 'acp-session', nativeSessionId: 'native-session' })
        expect(yield* store.bindSession('folio-session', { acpSessionId: 'new', nativeSessionId: 'native-session' }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
        expect(yield* store.createSession({ id: 'codex', taskId: 'task', agent: 'codex', adapterVersion: '1', purpose: 'task', syncOperationId: null }).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
        yield* store.createSession({ id: 'second', taskId: 'task', agent: 'pi', adapterVersion: '1', purpose: 'task', syncOperationId: null })
        yield* store.bindSession('second', { acpSessionId: 'second-acp', nativeSessionId: null })
        yield* reserveClaimedRun(run)
        yield* finishClaimedRun('run', 'failed')
        expect(yield* reserveClaimedRun({ ...run, id: 'invalid', sessionId: 'second', purpose: 'recovery', resumesRunId: 'run' }).pipe(Effect.flip)).toMatchObject({
          reason: 'invalid-state'
        })
        expect(yield* reserveClaimedRun({ ...run, id: 'invalid', sessionId: 'missing' }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
        expect(yield* store.runs('task')).toHaveLength(1)
        // Constraints also protect callers that accidentally bypass the service boundary.
        const sql = yield* SqlClient.SqlClient
        expect(yield* sql`UPDATE runs SET task_id='unknown' WHERE id='run'`.pipe(Effect.flip)).toMatchObject({ _tag: 'SqlError' })
        expect(yield* sql`UPDATE sessions SET task_id='unknown' WHERE id='folio-session'`.pipe(Effect.flip)).toMatchObject({ _tag: 'SqlError' })
      }).pipe(Effect.provide(layer()))
    )
  })

  it('isolates Vaults and leaves failed transitions unchanged', async () => {
    await Effect.runPromise(setup.pipe(Effect.provide(layer())))
    const other = join(root, 'other-vault')
    await mkdir(other)
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* HarnessStore
        expect(yield* store.task('task').pipe(Effect.flip)).toMatchObject({ reason: 'not-found' })
        expect(yield* store.sessions('task')).toEqual([])
        expect(yield* Effect.flatMap(ExecutionQueue, queue => queue.running('unknown', 'owner')).pipe(Effect.provide(ExecutionQueue.layer), Effect.flip)).toMatchObject({ reason: 'invalid-state' })
        yield* setup
      }).pipe(Effect.provide(layer(other)))
    )
  })
})
