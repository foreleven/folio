import { Effect, Layer } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { RoutineTrigger } from '../../shared/routine'
import { HarnessStore } from './harness-store'
import { RoutineStore } from './routine-store'
import { vaultDatabaseLayer } from './vault-database'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'folio-routine-queue-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const layer = () => Layer.mergeAll(HarnessStore.layer, RoutineStore.layer).pipe(Layer.provideMerge(vaultDatabaseLayer(root)))
const definition = { name: 'Scheduled notes', prompt: 'original', enabled: true, model: null,
  configuration: { agent: 'codex' as const, skillIds: [], integrationIds: [] } }

/** Storage fixture materializes a claimed batch; real filesystem/native dispatch is tested at TaskService. */
const prepare = Effect.fn('test.prepare')(function*(trigger: RoutineTrigger) {
  const store = yield* HarnessStore
  const routines = yield* RoutineStore
  const sql = yield* SqlClient.SqlClient
  yield* store.createTask({ id: trigger.taskId, goal: trigger.snapshot.definition.prompt, configuration: definition.configuration,
    worktree: `/worktrees/${trigger.taskId}`, branch: trigger.taskId })
  yield* sql`UPDATE tasks SET worktree_state='ready', worktree_base='base' WHERE id=${trigger.taskId}`
  const intent = yield* routines.prepareExecution(trigger.id)
  yield* store.createSession({ id: intent.sessionId, taskId: trigger.taskId, agent: 'codex', adapterVersion: 'fixture', purpose: 'task', syncOperationId: null })
  yield* store.bindSession(intent.sessionId, { acpSessionId: randomUUID(), nativeSessionId: null })
  yield* store.reserveRun({ id: intent.runId, taskId: trigger.taskId, sessionId: intent.sessionId,
    prompt: trigger.snapshot.definition.prompt, purpose: 'execution', resumesRunId: null, baselineCommit: 'base' })
  return intent
})

it('coalesces busy occurrences using the definition at dispatch and retains individual timestamps across restart', async () => {
  const id = randomUUID()
  const wakeups = [10, 20, 30].map(triggeredAt => ({ id: randomUUID(), routineId: id, triggeredAt }))
  const batch = await Effect.runPromise(Effect.gen(function*() {
    const routines = yield* RoutineStore
    const store = yield* HarnessStore
    yield* routines.save({ id, expectedRevision: null, definition })
    const first = yield* routines.claim({ id: randomUUID(), routineId: id, expectedRevision: 1 })
    const intent = yield* prepare(first)
    for (const wakeup of wakeups) yield* routines.enqueue(wakeup)
    expect(yield* routines.claimPending(id)).toBeNull()
    expect(yield* routines.triggers(id)).toHaveLength(1)
    yield* routines.save({ id, expectedRevision: 1, definition: { ...definition, prompt: 'updated' } })
    yield* store.finishRun(intent.runId, 'failed')
    const accepted = yield* routines.claimPending(id)
    expect(accepted?.snapshot.definition.prompt).toBe('updated')
    expect(accepted?.expectedRevision).toBe(2)
    expect((yield* routines.wakeups(id)).map(w => w.triggeredAt)).toEqual([10, 20, 30])
    expect(new Set((yield* routines.wakeups(id)).map(w => w.triggerId))).toEqual(new Set([accepted!.id]))
    return accepted!
  }).pipe(Effect.provide(layer())))
  await Effect.runPromise(Effect.gen(function*() {
    const routines = yield* RoutineStore
    expect(yield* routines.claimPending(id)).toEqual(batch)
    expect((yield* routines.enqueue(wakeups[0]!)).triggerId).toBe(batch.id)
    expect(yield* routines.wakeups(id)).toHaveLength(3)
    yield* routines.save({ id, expectedRevision: 2, definition: { ...definition, prompt: 'newer' } })
    expect(yield* routines.claimPending(id)).toEqual(batch)
    yield* routines.enqueue({ id: randomUUID(), routineId: id, triggeredAt: 40 })
    expect(yield* routines.claimPending(id)).toEqual(batch)
    expect((yield* routines.wakeups(id)).at(-1)?.triggerId).toBeNull()
    const intent = yield* prepare(batch)
    expect(yield* routines.claimPending(id)).toBeNull()
    yield* (yield* HarnessStore).finishRun(intent.runId, 'interrupted')
    const next = yield* routines.claimPending(id)
    expect(next?.id).not.toBe(batch.id)
    expect(next?.snapshot.definition.prompt).toBe('newer')
    expect((yield* routines.wakeups(id)).at(-1)?.triggerId).toBe(next?.id)
  }).pipe(Effect.provide(layer())))
})

it('retains pending input while paused, rejects changed retry identities, and resumes without dropping history', async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const routines = yield* RoutineStore
    const id = randomUUID()
    yield* routines.save({ id, expectedRevision: null, definition })
    const input = { id: randomUUID(), routineId: id, triggeredAt: 1 }
    const saved = yield* routines.enqueue(input)
    yield* routines.save({ id, expectedRevision: 1, definition: { ...definition, enabled: false } })
    expect(yield* routines.enqueue(input)).toEqual(saved)
    expect(yield* routines.claimPending(id)).toBeNull()
    expect(yield* routines.enqueue({ ...input, id: randomUUID() }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    expect(yield* routines.enqueue({ ...input, triggeredAt: 2 }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    expect(yield* routines.enqueue({ ...input, routineId: randomUUID() }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    yield* routines.save({ id, expectedRevision: 2, definition })
    expect((yield* routines.claimPending(id))?.expectedRevision).toBe(3)
    expect(yield* routines.wakeups(id)).toHaveLength(1)
  }).pipe(Effect.provide(layer())))
})

it('waits for successful Task completion and all synchronization, and retains conflict work', async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const routines = yield* RoutineStore
    const store = yield* HarnessStore
    const sql = yield* SqlClient.SqlClient
    const id = randomUUID()
    yield* routines.save({ id, expectedRevision: null, definition })
    yield* routines.enqueue({ id: randomUUID(), routineId: id, triggeredAt: 1 })
    const first = (yield* routines.claimPending(id))!
    const intent = yield* prepare(first)
    yield* routines.enqueue({ id: randomUUID(), routineId: id, triggeredAt: 2 })
    yield* store.finishRun(intent.runId, 'succeeded')
    expect(yield* routines.claimPending(id)).toBeNull()
    yield* sql`UPDATE runs SET sync_state='completed' WHERE id=${intent.runId}`
    expect(yield* routines.claimPending(id)).toBeNull()
    yield* sql`UPDATE tasks SET state='completed' WHERE id=${first.taskId}`
    const next = (yield* routines.claimPending(id))!
    const second = yield* prepare(next)
    yield* store.finishRun(second.runId, 'failed')
    yield* routines.enqueue({ id: randomUUID(), routineId: id, triggeredAt: 3 })
    yield* sql`UPDATE runs SET sync_state='conflict' WHERE id=${second.runId}`
    expect(yield* routines.enqueue({ id: randomUUID(), routineId: id, triggeredAt: 4 }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    expect(yield* routines.claimPending(id)).toBeNull()
    expect((yield* routines.wakeups(id)).at(-1)?.triggerId).toBeNull()
    const independent = randomUUID()
    yield* routines.save({ id: independent, expectedRevision: null, definition })
    yield* routines.enqueue({ id: randomUUID(), routineId: independent, triggeredAt: 3 })
    const other = (yield* routines.claimPending(independent))!
    expect(other.routineId).toBe(independent)
    const [pending] = (yield* routines.wakeups(id)).filter(w => w.triggerId === null)
    expect(yield* sql`UPDATE routine_wakeups SET trigger_id=${other.id} WHERE id=${pending!.id}`.pipe(Effect.flip)).toMatchObject({ _tag: 'SqlError' })
  }).pipe(Effect.provide(layer())))
})

it('independent SQLite connections cannot consume one pending batch twice', async () => {
  const id = randomUUID()
  await Effect.runPromise(Effect.gen(function*() {
    const routines = yield* RoutineStore
    yield* routines.save({ id, expectedRevision: null, definition })
    yield* routines.enqueue({ id: randomUUID(), routineId: id, triggeredAt: 1 })
  }).pipe(Effect.provide(layer())))
  const claim = () => Effect.runPromise(Effect.flatMap(RoutineStore, store => store.claimPending(id)).pipe(Effect.provide(layer())))
  const attempts = await Promise.allSettled([claim(), claim()])
  expect(attempts.some(attempt => attempt.status === 'fulfilled')).toBe(true)
  const accepted = await claim()
  for (const attempt of attempts) {
    if (attempt.status === 'fulfilled') expect(attempt.value).toEqual(accepted)
    // SQLite may reject a competing writer; the durable batch remains available for a safe explicit retry.
    else expect(attempt.reason).toMatchObject({ reason: 'storage' })
  }
  await Effect.runPromise(Effect.gen(function*() {
    const routines = yield* RoutineStore
    expect(yield* routines.triggers(id)).toEqual([accepted])
    expect((yield* routines.wakeups(id)).map(w => w.triggerId)).toEqual([accepted!.id])
  }).pipe(Effect.provide(layer())))
})

it('concurrent claims share one batch and cannot rebind its recorded occurrences', async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const routines = yield* RoutineStore
    const sql = yield* SqlClient.SqlClient
    const id = randomUUID()
    yield* routines.save({ id, expectedRevision: null, definition })
    const input = { id: randomUUID(), routineId: id, triggeredAt: 1 }
    yield* Effect.all([routines.enqueue(input), routines.enqueue(input)], { concurrency: 'unbounded' })
    const [a, b] = yield* Effect.all([routines.claimPending(id), routines.claimPending(id)], { concurrency: 'unbounded' })
    expect(a).toEqual(b)
    expect(yield* routines.triggers(id)).toHaveLength(1)
    expect(yield* routines.wakeups(id)).toHaveLength(1)
    expect(yield* sql`UPDATE routine_wakeups SET trigger_id=NULL WHERE id=${input.id}`.pipe(Effect.flip)).toMatchObject({ _tag: 'SqlError' })
    expect(yield* sql`UPDATE routine_wakeups SET triggered_at=2 WHERE id=${input.id}`.pipe(Effect.flip)).toMatchObject({ _tag: 'SqlError' })
  }).pipe(Effect.provide(layer())))
})

it.each(['insert', 'update'])('pauses atomically on conflict %s, protects edits, and requires explicit re-enable after resolution', async operation => {
  const id = randomUUID()
  const saved = await Effect.runPromise(Effect.gen(function*() {
    const routines = yield* RoutineStore
    const store = yield* HarnessStore
    const sql = yield* SqlClient.SqlClient
    yield* routines.save({ id, expectedRevision: null, definition })
    const original = yield* routines.claim({ id: randomUUID(), routineId: id, expectedRevision: 1 })
    const execution = yield* prepare(original)
    yield* store.finishRun(execution.runId, 'failed')
    const wakeup = { id: randomUUID(), routineId: id, triggeredAt: 1 }
    yield* routines.enqueue(wakeup)
    const conflictId = operation === 'insert' ? randomUUID() : execution.runId
    const conflict = operation === 'insert'
      ? sql`INSERT INTO runs (id, task_id, session_id, prompt, purpose, baseline_commit, state, sync_state, created_at, ended_at)
          VALUES (${conflictId}, ${original.taskId}, ${execution.sessionId}, 'conflict', 'execution', 'base', 'failed', 'conflict', 0, 0)`
      : sql`UPDATE runs SET sync_state='conflict' WHERE id=${conflictId}`
    // A failed transaction cannot publish half of the Run/Routine state transition.
    expect(yield* sql.withTransaction(conflict.pipe(Effect.andThen(Effect.fail('rollback')))).pipe(Effect.flip)).toBe('rollback')
    expect(yield* routines.list).toMatchObject([{ revision: 1, definition: { enabled: true } }])
    yield* conflict
    const [paused] = yield* routines.list
    expect(paused).toMatchObject({ revision: 2, definition: { ...definition, enabled: false } })
    expect(paused!.updatedAt).toBeGreaterThanOrEqual(paused!.createdAt)
    expect(yield* routines.forTask(original.taskId)).toEqual(original)
    expect(yield* routines.enqueue(wakeup)).toMatchObject({ id: wakeup.id, triggerId: null })
    expect(yield* routines.claimPending(id)).toBeNull()
    expect(yield* routines.save({ id, expectedRevision: 1, definition }).pipe(Effect.flip))
      .toMatchObject({ reason: 'routine-conflict', message: expect.stringContaining('synchronization conflicts') })
    expect(yield* sql`UPDATE routines SET definition=json_set(definition, '$.enabled', json('true')) WHERE id=${id}`
      .pipe(Effect.flip)).toMatchObject({ _tag: 'SqlError' })
    yield* routines.save({ id, expectedRevision: 2, definition: { ...definition, prompt: 'edited while paused', enabled: false } })
    yield* sql`UPDATE runs SET sync_state='conflict' WHERE id=${conflictId}`
    expect(yield* routines.list).toMatchObject([{ revision: 3, definition: { enabled: false } }])
    // Pausing the Routine must not prevent its original Task from running conflict resolution.
    // The resolver uses a dedicated operation-bound Session; a normal execution Session cannot
    // be repurposed for this purpose.
    const operationId = randomUUID()
    yield* sql`INSERT INTO git_sync_operations
      (id, task_id, source_frontier, source_head, source_changes, source_commits, main_base, state, created_at)
      VALUES (${operationId}, ${original.taskId}, 'base', 'source', '[]', '[]', 'base', 'preparing', 1)`
    yield* sql`UPDATE git_sync_operations SET state='conflict', conflict_index=0 WHERE id=${operationId}`
    const resolvingSession = randomUUID()
    yield* store.createSession({ id: resolvingSession, taskId: original.taskId, agent: 'codex', adapterVersion: 'fixture',
      purpose: 'conflict-resolution', syncOperationId: operationId })
    yield* store.bindSession(resolvingSession, { acpSessionId: randomUUID(), nativeSessionId: null })
    const resolving = randomUUID()
    yield* store.reserveRun({ id: resolving, taskId: original.taskId, sessionId: resolvingSession,
      prompt: 'resolve', purpose: 'conflict-resolution', resumesRunId: null, baselineCommit: 'base' })
    yield* store.finishRun(resolving, 'failed')
    return { conflictId, original, wakeup }
  }).pipe(Effect.provide(layer())))
  await Effect.runPromise(Effect.gen(function*() {
    const routines = yield* RoutineStore
    const sql = yield* SqlClient.SqlClient
    expect(yield* routines.list).toMatchObject([{ revision: 3, definition: { enabled: false } }])
    yield* sql`UPDATE runs SET sync_state='completed' WHERE id=${saved.conflictId}`
    expect(yield* routines.claimPending(id)).toBeNull()
    expect(yield* routines.list).toMatchObject([{ revision: 3, definition: { enabled: false } }])
    yield* routines.save({ id, expectedRevision: 3, definition: { ...definition, prompt: 'edited while paused' } })
    const accepted = yield* routines.claimPending(id)
    expect(accepted?.snapshot.definition.prompt).toBe('edited while paused')
    expect(accepted?.expectedRevision).toBe(4)
    expect(yield* routines.wakeups(id)).toMatchObject([{ id: saved.wakeup.id, triggerId: accepted?.id }])
  }).pipe(Effect.provide(layer())))
})

it('applies conflict pause to an older ledger once without changing accepted snapshots or wakeups', async () => {
  const id = randomUUID()
  const snapshot = await Effect.runPromise(Effect.gen(function*() {
    const routines = yield* RoutineStore
    const store = yield* HarnessStore
    const sql = yield* SqlClient.SqlClient
    yield* routines.save({ id, expectedRevision: null, definition })
    const original = yield* routines.claim({ id: randomUUID(), routineId: id, expectedRevision: 1 })
    const execution = yield* prepare(original)
    yield* store.finishRun(execution.runId, 'failed')
    yield* routines.enqueue({ id: randomUUID(), routineId: id, triggeredAt: 1 })
    // Recreate the prior schema boundary: it admitted conflict rows without updating Routine state.
    yield* sql`DROP TRIGGER routine_pause_on_conflict_insert`
    yield* sql`DROP TRIGGER routine_pause_on_conflict_update`
    yield* sql`DROP TRIGGER routine_enable_without_conflicts`
    yield* sql`DROP TRIGGER runs_git_save_insert`
    yield* sql`DROP TRIGGER runs_git_save_update`
    yield* sql`DROP TRIGGER session_uses_task_agent`
    yield* sql`DROP TRIGGER session_execution_identity_immutable`
    yield* sql`DROP TRIGGER session_conflict_target`
    yield* sql`DROP TRIGGER run_uses_session_target`
    yield* sql`DROP TRIGGER runs_without_git_sync_insert`
    yield* sql`DROP TRIGGER runs_without_git_sync_update`
    // Migration 0017 adds durable conflict replay inputs; remove its guards/table
    // as well when reconstructing the pre-sync legacy schema for this test.
    yield* sql`DROP TRIGGER git_sync_resolution_input_shape`
    yield* sql`DROP TRIGGER git_sync_resolution_input_immutable`
    yield* sql`DROP TRIGGER git_sync_resolution_input_retained`
    yield* sql`DROP TABLE git_sync_resolution_inputs`
    yield* sql`DROP TABLE git_sync_operations`
    yield* sql`DROP TABLE git_change_applications`
    yield* sql`DROP TABLE git_change_preparation_runs`
    yield* sql`DROP TABLE git_change_preparations`
    yield* sql`DROP TABLE routine_schedules`
    yield* sql`DROP TABLE vault_schedule_settings`
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id>=11`
    yield* sql`UPDATE runs SET sync_state='conflict' WHERE id=${execution.runId}`
    expect(yield* routines.list).toMatchObject([{ revision: 1, definition: { enabled: true } }])
    return original
  }).pipe(Effect.provide(layer())))
  for (let reopen = 0; reopen < 2; reopen++) {
    await Effect.runPromise(Effect.gen(function*() {
      const routines = yield* RoutineStore
      expect(yield* routines.list).toMatchObject([{ revision: 2, definition: { enabled: false } }])
      expect(yield* routines.forTask(snapshot.taskId)).toEqual(snapshot)
      expect(yield* routines.wakeups(id)).toMatchObject([{ triggeredAt: 1, triggerId: null }])
    }).pipe(Effect.provide(layer())))
  }
})
