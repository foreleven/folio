import { Effect, Layer } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { HarnessStore } from './harness-store'
import { RoutineStore } from './routine-store'
import { vaultDatabaseLayer } from './vault-database'
import type { NewRun } from '../../shared/harness'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'folio-routine-execution-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const layer = () => Layer.mergeAll(HarnessStore.layer, RoutineStore.layer).pipe(Layer.provideMerge(vaultDatabaseLayer(root)))

/** Creates real occurrence relationships and storage-only ready checkouts, without native Agent execution. */
const setup = Effect.gen(function*() {
  const routines = yield* RoutineStore
  const store = yield* HarnessStore
  const sql = yield* SqlClient.SqlClient
  const configuration = { agent: 'codex' as const, integrationIds: [], skillIds: [] }
  const first = randomUUID()
  const other = randomUUID()
  for (const id of [first, other]) yield* routines.save({ id, expectedRevision: null,
    definition: { name: 'Routine', prompt: 'Fixture', enabled: true, model: null, configuration } })
  const runs: NewRun[] = []
  for (const routineId of [first, first, other, null]) {
    const taskId = routineId ? (yield* routines.claim({ id: randomUUID(), routineId, expectedRevision: 1 })).taskId : randomUUID()
    yield* store.createTask({ id: taskId, goal: 'Fixture', configuration, branch: taskId, worktree: `/worktrees/${taskId}` })
    yield* sql`UPDATE tasks SET worktree_state='ready', worktree_base='base' WHERE id=${taskId}`
    const sessionId = randomUUID()
    yield* store.createSession({ id: sessionId, taskId, agent: 'codex', adapterVersion: 'fixture', purpose: 'task', syncOperationId: null })
    yield* store.bindSession(sessionId, { acpSessionId: randomUUID(), nativeSessionId: null })
    runs.push({ id: randomUUID(), taskId, sessionId, prompt: 'Fixture', purpose: 'execution', resumesRunId: null, baselineCommit: 'base' })
  }
  return runs as [NewRun, NewRun, NewRun, NewRun]
})

it('reserves a Routine during preparing/running, admits unrelated Tasks and gates old-task recovery', async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const [first, sibling, other, manual] = yield* setup
    const store = yield* HarnessStore
    yield* store.reserveRun(first)
    expect(yield* store.reserveRun(sibling).pipe(Effect.flip)).toMatchObject({ reason: 'routine-busy' })
    yield* store.markRunning(first.id)
    expect(yield* store.reserveRun(sibling).pipe(Effect.flip)).toMatchObject({ reason: 'routine-busy' })
    yield* store.reserveRun(other)
    yield* store.reserveRun(manual)
    yield* store.finishRun(first.id, 'failed')
    yield* store.reserveRun(sibling)
    const recovery: NewRun = { ...first, id: randomUUID(), purpose: 'recovery', resumesRunId: first.id }
    expect(yield* store.reserveRun(recovery).pipe(Effect.flip)).toMatchObject({ reason: 'routine-busy' })
    yield* store.finishRun(sibling.id, 'interrupted')
    yield* store.reserveRun(recovery)
    expect(yield* store.runs(first.taskId)).toMatchObject([{ state: 'failed' }, { state: 'preparing', purpose: 'recovery' }])
  }).pipe(Effect.provide(layer())))
})

it('enforces admission on direct SQL writes and retains immutable Routine ownership for old Tasks', async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const [first, sibling] = yield* setup
    const store = yield* HarnessStore
    const sql = yield* SqlClient.SqlClient
    yield* store.reserveRun(first)
    yield* store.finishRun(first.id, 'failed')
    yield* store.reserveRun(sibling)
    expect(yield* sql`UPDATE runs SET state='preparing', ended_at=NULL WHERE id=${first.id}`.pipe(Effect.flip)).toMatchObject({ _tag: 'SqlError' })
    expect(yield* sql`INSERT INTO runs (id, task_id, session_id, prompt, purpose, baseline_commit, state, sync_state, created_at)
      VALUES ('bypass', ${first.taskId}, ${first.sessionId}, 'Fixture', 'execution', 'base', 'running', 'pending', 0)`.pipe(Effect.flip)).toMatchObject({ _tag: 'SqlError' })
    expect(yield* sql`DELETE FROM routine_triggers WHERE task_id=${first.taskId}`.pipe(Effect.flip)).toMatchObject({ _tag: 'SqlError' })
    expect(yield* sql`UPDATE routine_triggers SET task_id='different' WHERE task_id=${first.taskId}`.pipe(Effect.flip)).toMatchObject({ _tag: 'SqlError' })
    expect((yield* store.runs(first.taskId))[0]!.state).toBe('failed')
    // State updates to the already admitted winner must not conflict with itself.
    yield* store.markRunning(sibling.id)
    expect((yield* store.runs(sibling.taskId))[0]!.state).toBe('running')
  }).pipe(Effect.provide(layer())))
})

it('admits only one competing Run from independent Node processes against the same database', async () => {
  const [first, sibling] = await Effect.runPromise(setup.pipe(Effect.provide(layer())))
  const execute = promisify(execFile)
  const script = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000');
    const run = JSON.parse(process.argv[2]);
    try {
      db.prepare("INSERT INTO runs (id, task_id, session_id, prompt, purpose, baseline_commit, state, sync_state, created_at) VALUES (?, ?, ?, ?, 'execution', 'base', 'preparing', 'pending', 0)")
        .run(run.id, run.taskId, run.sessionId, run.prompt);
      process.stdout.write('accepted');
    } catch (error) {
      if (!error.message.includes('Routine already has an active Run')) throw error;
      process.stdout.write('blocked');
    } finally { db.close(); }
  `
  const results = await Promise.all([first, sibling].map(run => execute(process.execPath,
    ['-e', script, join(root, 'data.db'), JSON.stringify(run)], { timeout: 5000 })))
  expect(results.map(result => result.stdout).sort()).toEqual(['accepted', 'blocked'])
})

it('holds a successful Task until synchronization completes, while permitting same-Task continuation', async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const [first, sibling] = yield* setup
    const store = yield* HarnessStore
    const sql = yield* SqlClient.SqlClient
    yield* store.reserveRun(first)
    yield* store.finishRun(first.id, 'succeeded')
    expect(yield* store.reserveRun(sibling).pipe(Effect.flip)).toMatchObject({ reason: 'routine-busy' })
    expect(yield* sql`INSERT INTO runs (id, task_id, session_id, prompt, purpose, baseline_commit, state, sync_state, created_at)
      VALUES ('sync-bypass', ${sibling.taskId}, ${sibling.sessionId}, 'Fixture', 'execution', 'base', 'preparing', 'pending', 0)`
      .pipe(Effect.flip)).toMatchObject({ _tag: 'SqlError' })
    const continuation = { ...first, id: randomUUID() }
    yield* store.reserveRun(continuation)
    yield* store.finishRun(continuation.id, 'failed')
    // Simulate the future Git coordinator's confirmed synchronization receipt; no Git behavior is inferred.
    yield* sql`UPDATE runs SET sync_state='completed' WHERE id=${first.id}`
    yield* store.reserveRun(sibling)
    yield* store.finishRun(sibling.id, 'failed')
    yield* sql`UPDATE runs SET sync_state='conflict' WHERE id=${sibling.id}`
    expect(yield* store.reserveRun({ ...first, id: randomUUID() }).pipe(Effect.flip)).toMatchObject({ reason: 'routine-busy' })
    // Conflict handling belongs to its original Task, but requires an operation-bound
    // conflict Session; a normal Task Session must not be repurposed to bypass that boundary.
    expect(yield* store.reserveRun({ ...sibling, id: randomUUID(), purpose: 'conflict-resolution' }).pipe(Effect.flip))
      .toMatchObject({ reason: 'invalid-state' })
  }).pipe(Effect.provide(layer())))
})
