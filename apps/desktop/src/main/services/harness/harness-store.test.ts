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
import type { NewRun } from '../../../shared/harness'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'folio-harness-store-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
/** Rebuild layers for every invocation to verify disk persistence rather than shared in-memory objects. */
function layer(directory = root) {
  return HarnessStore.layer.pipe(Layer.provideMerge(vaultDatabaseLayer(directory)))
}
/** Supplies three deliberately distinct identities for a bound Session. */
const setup = Effect.gen(function* () {
  const store = yield* HarnessStore
  yield* store.createTask({
    id: 'task',
    goal: 'Summarize notes',
    configuration: { agent: 'pi', skillIds: ['notes'], integrationIds: ['lark'] },
    branch: 'task/task',
    worktree: '/worktrees/task'
  })
  // Storage-only fixture: the real Git resource boundary is covered by TaskWorktrees tests.
  yield* Effect.flatMap(SqlClient.SqlClient, (sql) => sql`UPDATE tasks SET worktree_state='ready', worktree_base='baseline' WHERE id='task'`)
  yield* store.createSession({ id: 'folio-session', taskId: 'task', agent: 'pi', adapterVersion: '1', purpose: 'task', syncOperationId: null })
  yield* store.bindSession('folio-session', { acpSessionId: 'acp-session', nativeSessionId: 'native-session' })
})
const run: NewRun = { id: 'run', taskId: 'task', sessionId: 'folio-session', prompt: 'Read the notes', purpose: 'execution', resumesRunId: null, baselineCommit: 'baseline' }

describe('Vault harness execution ledger', () => {
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
          goal: 'Other',
          configuration: { agent: 'pi', skillIds: [], integrationIds: [] },
          branch: 'task/other',
          worktree: '/worktrees/other'
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
