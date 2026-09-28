import { NodeServices } from '@effect/platform-node'
import { TaskWorktrees } from '../tasks/task-worktrees'
import { ExecutionQueue } from '../execution/execution-queue'
import { HarnessStore } from '../harness/harness-store'
import { SqlClient } from 'effect/unstable/sql'
import { Effect, Layer } from 'effect'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RoutineStore } from './routine-store'
import { vaultDatabaseLayer } from '../vault/vault-database'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'folio-routine-store-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const layer = () => RoutineStore.layer.pipe(Layer.provide(TaskWorktrees.layer(root)), Layer.provideMerge(Layer.merge(HarnessStore.layer(root), ExecutionQueue.layer)), Layer.provideMerge(vaultDatabaseLayer(root)), Layer.provide(NodeServices.layer))
const routineId = '11111111-1111-4111-8111-111111111111'
const sessionId = '22222222-2222-4222-8222-222222222222'
const runId = (n: number) => `33333333-3333-4333-8333-${n.toString().padStart(12, '0')}`
const agentConfiguration = (goal: string, agent: 'pi' | 'codex' = 'codex', model: { providerId: string; modelId: string; thinkingLevel: 'off' } | null = null) => ({
  goal, agent, model, skillIds: [], integrationIds: ['lark'], resourceIds: ['lark/im']
})

const setup = Effect.gen(function* () {
  const store = yield* RoutineStore
  yield* store.save({ id: routineId, expectedRevision: null, name: 'Inbox', type: 'agent', configuration: agentConfiguration('Process today'), trigger: { type: 'schedule', intervalMinutes: 30, timeZone: 'UTC' }, enabled: true })
})

const finish = (id: string, state: 'succeeded' | 'failed' | 'interrupted' | 'cancelled') => Effect.gen(function* () {
  const tasks = yield* HarnessStore
  const queue = yield* ExecutionQueue
  const sql = yield* SqlClient.SqlClient
  const task = (yield* tasks.tasks)[0]!
  if (!(yield* tasks.sessions(task.id)).length)
    yield* tasks.createSession({ id: sessionId, taskId: task.id, agent: 'codex', adapterVersion: '1', purpose: 'task', syncOperationId: null })
  yield* queue.submit({ id, taskId: task.id, sessionId, prompt: 'fixed window', purpose: 'execution', resumesRunId: null, source: 'routine' })
  if (state === 'cancelled') {
    yield* queue.cancel(id)
    return task.id
  }
  yield* queue.claim(`owner-${id}`)
  yield* sql`UPDATE runs SET baseline_commit='verified' WHERE id=${id}`
  yield* queue.running(id, `owner-${id}`)
  yield* queue.finish(id, `owner-${id}`, state)
  return task.id
})

describe('RoutineStore bounded execution windows', () => {
  it('lists event Routine Tasks without requiring or inventing a scheduled window', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* RoutineStore
      const routine = yield* store.ensureRawIntake
      if (routine.type !== 'agent') throw new Error('Expected Agent Routine')
      const tasks = yield* HarnessStore
      const taskId = '44444444-4444-4444-8444-444444444444'
      yield* tasks.createTask({ id: taskId, type: 'agent', receipt: null,
        configuration: { ...routine.configuration, rawInput: { fromCommit: null, toCommit: 'a'.repeat(40) } } })
      yield* tasks.createTask({ id: '55555555-5555-4555-8555-555555555555', type: 'agent', receipt: null,
        configuration: { ...routine.configuration, rawInput: null } })
      const sql = yield* SqlClient.SqlClient
      const createdAt = Date.parse('2026-09-28T10:15:40+08:00')
      yield* sql`UPDATE tasks SET routine_id=${routine.id}, routine_revision=${routine.revision}, created_at=${createdAt} WHERE id=${taskId}`
      yield* tasks.createSession({ id: sessionId, taskId, agent: 'codex', adapterVersion: '1', purpose: 'task', syncOperationId: null })
      const queue = yield* ExecutionQueue
      yield* queue.submit({ id: runId(8), taskId, sessionId, prompt: 'Organize raw input', purpose: 'execution', resumesRunId: null, source: 'routine' })
      const expected = { routineId: routine.id, taskId, runId: runId(8), triggerTime: createdAt,
        routineDate: null, windowStart: null, windowEnd: null, timeZone: null, status: 'pending' }
      expect(yield* store.executions(routine.id)).toMatchObject([expected])
      expect(yield* store.allExecutions).toMatchObject([expected])
      expect(yield* store.executionForTask(taskId)).toMatchObject(expected)
      expect(yield* sql`SELECT task_id FROM routine_schedules WHERE task_id=${taskId}`).toEqual([])
      yield* queue.claim('knowledge-owner')
      yield* sql`UPDATE runs SET baseline_commit='verified' WHERE id=${runId(8)}`
      yield* queue.running(runId(8), 'knowledge-owner')
      yield* queue.finish(runId(8), 'knowledge-owner', 'interrupted')
      expect(yield* store.executions(routine.id)).toMatchObject([{ ...expected, status: 'interrupted' }])
      yield* queue.submit({ id: runId(9), taskId, sessionId, prompt: 'Retry the frozen input', purpose: 'recovery', resumesRunId: runId(8), source: 'recovery' })
      yield* queue.claim('retry-owner')
      yield* sql`UPDATE runs SET baseline_commit='verified' WHERE id=${runId(9)}`
      yield* queue.running(runId(9), 'retry-owner')
      yield* queue.finish(runId(9), 'retry-owner', 'succeeded')
      // Agent success still awaits the Task's canonical publication/no-change receipt.
      expect(yield* store.executions(routine.id)).toMatchObject([{ ...expected, runId: runId(9), status: 'pending' }])
      yield* sql`UPDATE runs SET sync_state='not-required' WHERE id=${runId(9)}`
      yield* sql`UPDATE tasks SET state='completed' WHERE id=${taskId}`
      expect(yield* store.executions(routine.id)).toMatchObject([{ ...expected, runId: runId(9), status: 'succeeded' }])
    }).pipe(Effect.provide(layer())))
  })

  it('keeps the built-in raw intake trigger system-owned', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* RoutineStore
      const raw = yield* store.ensureRawIntake
      if (raw.type !== 'agent') throw new Error('Expected Agent Routine')
      expect((yield* store.save({ id: raw.id, expectedRevision: raw.revision, name: raw.name,
        type: 'agent', configuration: raw.configuration, trigger: { type: 'schedule', intervalMinutes: 60, timeZone: 'UTC' },
        enabled: raw.enabled }).pipe(Effect.flip)).reason).toBe('invalid-state')
      expect((yield* store.get(raw.id)).trigger).toMatchObject({ type: 'event', signal: 'raws-changed' })
    }).pipe(Effect.provide(layer())))
  })

  it.each([
    ['Asia/Shanghai', '2026-09-19T03:00:00Z', '2026-09-18T16:00:00Z'],
    ['America/New_York', '2026-03-08T16:00:00Z', '2026-03-08T05:00:00Z'],
    ['America/New_York', '2026-11-01T17:00:00Z', '2026-11-01T04:00:00Z']
  ])('starts at local midnight in %s and freezes the first one-hour window', async (timeZone, instant, midnight) => {
    await Effect.runPromise(Effect.gen(function* () {
      yield* setup
      const sql = yield* SqlClient.SqlClient
      const at = Date.parse(instant)
      yield* sql`UPDATE routines SET created_at=${at - 60_000}, trigger=json_set(trigger, '$.timeZone', ${timeZone}) WHERE id=${routineId}`
      const store = yield* RoutineStore
      const first = (yield* store.schedule(routineId, at))!
      expect(first.windowStart).toBe(Date.parse(midnight))
      expect(first.windowEnd).toBe(Date.parse(midnight) + 60 * 60_000)
      expect((yield* store.schedule(routineId, at + 60_000))?.taskId).toBe(first.taskId)
      expect((yield* store.executionForTask(first.taskId))?.windowEnd).toBe(first.windowEnd)
    }).pipe(Effect.provide(layer())))
  })

  it('does not create empty windows and advances one window after a full hour of backlog', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      yield* setup
      const store = yield* RoutineStore
      const first = (yield* store.schedule(routineId, Date.parse('2026-09-11T00:30:00Z')))!
      yield* finish(runId(1), 'succeeded')
      const idle = yield* store.schedule(routineId, Date.parse('2026-09-11T01:00:00Z'), 'settled')
      expect(idle).toBeNull()
      const next = (yield* store.schedule(routineId, Date.parse('2026-09-11T01:30:00Z'), 'settled'))!
      expect(next.taskId).not.toBe(first.taskId)
      expect(next.windowStart).toBe(first.windowEnd)
      expect(next.windowEnd).toBe(first.windowEnd! + 60 * 60_000)
    }).pipe(Effect.provide(layer())))
  })

  it.each(['failed', 'interrupted'] as const)('retries %s windows without moving their boundary', async (state) => {
    await Effect.runPromise(Effect.gen(function* () {
      yield* setup
      const store = yield* RoutineStore
      const first = (yield* store.schedule(routineId, Date.parse('2026-09-11T10:00:00Z')))!
      yield* finish(runId(2), state)
      const retry = (yield* store.schedule(routineId, Date.parse('2026-09-11T12:00:00Z')))!
      expect(retry.taskId).toBe(first.taskId)
      expect(retry.windowStart).toBe(first.windowStart)
      expect(retry.windowEnd).toBe(first.windowEnd)
    }).pipe(Effect.provide(layer())))
  })

  it('treats a stopped window as a repair gap and continues after its end', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      yield* setup
      const store = yield* RoutineStore
      const first = (yield* store.schedule(routineId, Date.parse('2026-09-11T00:01:00Z')))!
      yield* finish(runId(3), 'cancelled')
      const waiting = yield* store.schedule(routineId, Date.parse('2026-09-11T00:15:00Z'), 'settled')
      expect(waiting).toBeNull()
      const advanced = (yield* store.schedule(routineId, Date.parse('2026-09-11T00:31:00Z'), 'settled'))!
      expect(advanced.taskId).not.toBe(first.taskId)
      expect(advanced.windowStart).toBe(first.windowEnd)
      expect(advanced.windowEnd).toBe(first.windowEnd! + 30 * 60_000)
    }).pipe(Effect.provide(layer())))
  })

  it('does not overlap an admitted execution', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      yield* setup
      const store = yield* RoutineStore
      const first = (yield* store.schedule(routineId, Date.parse('2026-09-11T10:00:00Z')))!
      const tasks = yield* HarnessStore
      yield* tasks.createSession({ id: sessionId, taskId: first.taskId, agent: 'codex', adapterVersion: '1', purpose: 'task', syncOperationId: null })
      const queue = yield* ExecutionQueue
      yield* queue.submit({ id: runId(4), taskId: first.taskId, sessionId, prompt: 'fixed window', purpose: 'execution', resumesRunId: null, source: 'routine' })
      yield* queue.claim('active-owner')
      yield* (yield* SqlClient.SqlClient)`UPDATE runs SET baseline_commit='verified' WHERE id=${runId(4)}`
      yield* queue.running(runId(4), 'active-owner')
      const same = (yield* store.schedule(routineId, Date.parse('2026-09-11T13:00:00Z')))!
      expect(same.taskId).toBe(first.taskId)
    }).pipe(Effect.provide(layer())))
  })

  it('retains the Routine revision, model, timezone, and frozen prompt snapshot', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* RoutineStore
      const model = { providerId: 'anthropic', modelId: 'original-model', thinkingLevel: 'off' as const }
      yield* store.save({ id: routineId, expectedRevision: null, name: 'Inbox', type: 'agent', configuration: agentConfiguration('Original prompt', 'pi', model), trigger: { type: 'schedule', intervalMinutes: 30, timeZone: 'UTC' }, enabled: true })
      const first = (yield* store.schedule(routineId, Date.parse('2026-09-11T10:00:00Z')))!
      yield* store.save({ id: routineId, expectedRevision: 1, name: 'Inbox', type: 'agent', configuration: { ...agentConfiguration('New prompt'), integrationIds: [], resourceIds: [] }, trigger: { type: 'schedule', intervalMinutes: 30, timeZone: 'America/Los_Angeles' }, enabled: true })
      const task = yield* (yield* HarnessStore).task(first.taskId)
      expect(task.type).toBe('agent')
      if (task.type !== 'agent') throw new Error('Expected Agent Task')
      expect(task.configuration.goal).toBe('Original prompt')
      expect(task.configuration.agent).toBe('pi')
      expect(first.routineRevision).toBe(1)
      expect(first.model).toEqual(model)
      expect(first.timeZone).toBe('UTC')
    }).pipe(Effect.provide(layer())))
  })

  it('creates short windows on checks and no windows at midnight or at the current boundary', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      yield* setup
      const store = yield* RoutineStore
      const midnight = Date.parse('2026-09-11T00:00:00Z')
      expect(yield* store.schedule(routineId, midnight)).toBeNull()
      const first = (yield* store.schedule(routineId, midnight + 600_000))!
      expect(first.windowEnd).toBe(midnight + 600_000)
      yield* finish(runId(5), 'succeeded')
      expect(yield* store.schedule(routineId, midnight + 600_000)).toBeNull()
      expect(yield* store.schedule(routineId, midnight + 900_000, 'settled')).toBeNull()
      const next = (yield* store.schedule(routineId, midnight + 900_000))!
      expect(next).toMatchObject({ windowStart: first.windowEnd, windowEnd: midnight + 900_000 })
      expect(yield* store.schedule(routineId, midnight + 3_600_000)).toEqual(next)
    }).pipe(Effect.provide(layer())))
  })

  it.each(['pending', 'failed', 'interrupted', 'cancelled', 'succeeded'] as const)(
    'leaves yesterday’s %s window for repair and begins today at midnight', async (status) => {
      await Effect.runPromise(Effect.gen(function* () {
        yield* setup
        const store = yield* RoutineStore
        const first = (yield* store.schedule(routineId, Date.parse('2026-09-11T12:00:00Z')))!
        if (status !== 'pending') yield* finish(runId(6), status)
        const next = (yield* store.schedule(routineId, Date.parse('2026-09-12T00:20:00Z')))!
        expect(next.taskId).not.toBe(first.taskId)
        expect(next).toMatchObject({ routineDate: '2026-09-12', windowStart: Date.parse('2026-09-12T00:00:00Z'), windowEnd: Date.parse('2026-09-12T00:20:00Z') })
        expect((yield* store.executionForTask(first.taskId))?.windowEnd).toBe(first.windowEnd)
      }).pipe(Effect.provide(layer())))
    })

  it.each(['succeeded', 'cancelled'] as const)('advances today after a previous-day execution settles as %s', async (state) => {
    await Effect.runPromise(Effect.gen(function* () {
      yield* setup
      const store = yield* RoutineStore
      yield* store.schedule(routineId, Date.parse('2026-09-11T23:00:00Z'))
      yield* finish(runId(8), state)
      const next = yield* store.schedule(routineId, Date.parse('2026-09-12T02:00:00Z'), 'settled')
      expect(next).toMatchObject({ routineDate: '2026-09-12', windowStart: Date.parse('2026-09-12T00:00:00Z'), windowEnd: Date.parse('2026-09-12T01:00:00Z') })
    }).pipe(Effect.provide(layer())))
  })

  it('holds the Routine across midnight until the live Agent actually stops', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      yield* setup
      const store = yield* RoutineStore
      const first = (yield* store.schedule(routineId, Date.parse('2026-09-11T23:00:00Z')))!
      const tasks = yield* HarnessStore
      const queue = yield* ExecutionQueue
      yield* tasks.createSession({ id: sessionId, taskId: first.taskId, agent: 'codex', adapterVersion: '1', purpose: 'task', syncOperationId: null })
      yield* queue.submit({ id: runId(7), taskId: first.taskId, sessionId, prompt: 'fixed', purpose: 'execution', resumesRunId: null, source: 'routine' })
      yield* queue.claim('owner')
      yield* queue.cancel(runId(7))
      expect(yield* store.schedule(routineId, Date.parse('2026-09-12T12:00:00Z'))).toMatchObject({ taskId: first.taskId, status: 'preparing', cancelRequested: true })
      expect(yield* store.schedule(routineId, Date.parse('2026-09-12T12:00:00Z'), 'settled')).toBeNull()
      yield* queue.finish(runId(7), 'owner', 'cancelled')
      expect((yield* store.schedule(routineId, Date.parse('2026-09-12T12:00:00Z')))?.routineDate).toBe('2026-09-12')
    }).pipe(Effect.provide(layer())))
  })

  it.each(['cancelled', 'conflict'] as const)('keeps an Ingestion %s window blocked for manual retry', async (status) => {
    await Effect.runPromise(Effect.gen(function* () {
      const ingestionRoutineId = '99999999-9999-4999-8999-999999999999'
      const store = yield* RoutineStore
      yield* store.save({ id: ingestionRoutineId, expectedRevision: null, name: 'Mailbox', type: 'ingestion',
        configuration: { integrationId: 'imap', resourceId: 'email' }, trigger: { type: 'schedule', intervalMinutes: 30, timeZone: 'UTC' }, enabled: true })
      const first = (yield* store.schedule(ingestionRoutineId, Date.parse('2026-09-11T00:30:00Z')))!
      const tasks = yield* HarnessStore
      const task = yield* tasks.task(first.taskId)
      if (task.type !== 'ingestion') return yield* Effect.die(new Error('Expected Ingestion Task'))
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE tasks SET receipt=${JSON.stringify({ ...task.receipt, state: status,
        cancelRequested: status === 'cancelled', endedAt: Date.parse('2026-09-11T00:31:00Z') })},
        state=${status === 'cancelled' ? 'cancelled' : 'active'} WHERE id=${task.id}`
      expect(yield* store.schedule(ingestionRoutineId, Date.parse('2026-09-11T03:00:00Z'))).toBeNull()
      expect(yield* store.schedule(ingestionRoutineId, Date.parse('2026-09-11T03:00:00Z'), 'settled')).toBeNull()
      expect(yield* store.executions(ingestionRoutineId)).toMatchObject([{ taskId: first.taskId, status }])
      expect((yield* tasks.tasks).filter(candidate => candidate.type === 'ingestion')).toHaveLength(1)
    }).pipe(Effect.provide(layer())))
  })

  it('normalizes resource lists and preserves save idempotency', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      yield* setup
      const store = yield* RoutineStore
      const previous = yield* store.get(routineId)
      if (previous.type !== 'agent') throw new Error('Expected Agent Routine')
      const { revision, createdAt: _created, updatedAt: _updated, nextTriggerAt: _next, lastTriggerAt: _last, ...input } = previous
      const updated = { ...input, expectedRevision: revision, configuration: { ...input.configuration, resourceIds: ['lark/im', 'lark/im'] } }
      const saved = yield* store.save(updated)
      expect(yield* store.save({ ...updated, configuration: { ...updated.configuration, resourceIds: ['lark/im'] } })).toEqual(saved)
      expect(yield* store.save({ ...updated, configuration: { ...updated.configuration, goal: 'different' } }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    }).pipe(Effect.provide(layer())))
  })

  it('rolls back a Task reservation when scheduling metadata cannot be saved', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      yield* setup
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TRIGGER reject_window BEFORE UPDATE OF routine_id ON tasks BEGIN SELECT RAISE(ABORT, 'fixture window failure'); END`
      const store = yield* RoutineStore
      expect(yield* store.schedule(routineId).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
      expect(yield* sql`SELECT id FROM tasks`).toHaveLength(0)
    }).pipe(Effect.provide(layer())))
  })
})
