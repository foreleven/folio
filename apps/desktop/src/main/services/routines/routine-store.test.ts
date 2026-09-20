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

const layer = () => RoutineStore.layer.pipe(Layer.provide(TaskWorktrees.layer(root)), Layer.provideMerge(Layer.merge(HarnessStore.layer, ExecutionQueue.layer)), Layer.provideMerge(vaultDatabaseLayer(root)), Layer.provide(NodeServices.layer))
const routineId = '11111111-1111-4111-8111-111111111111'
const sessionId = '22222222-2222-4222-8222-222222222222'
const runId = (n: number) => `33333333-3333-4333-8333-${n.toString().padStart(12, '0')}`

const setup = Effect.gen(function* () {
  const store = yield* RoutineStore
  yield* store.save({ id: routineId, expectedRevision: null, name: 'Inbox', prompt: 'Process today', agent: 'codex', model: null, skillIds: [], integrationIds: ['lark'], resourceIds: ['lark/im'], intervalMinutes: 30, timeZone: 'UTC', enabled: true })
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
  it.each([
    ['Asia/Shanghai', '2026-09-19T03:00:00Z', '2026-09-18T16:00:00Z'],
    ['America/New_York', '2026-03-08T16:00:00Z', '2026-03-08T05:00:00Z'],
    ['America/New_York', '2026-11-01T17:00:00Z', '2026-11-01T04:00:00Z']
  ])('starts at local midnight in %s and freezes the first one-hour window', async (timeZone, instant, midnight) => {
    await Effect.runPromise(Effect.gen(function* () {
      yield* setup
      const sql = yield* SqlClient.SqlClient
      const at = Date.parse(instant)
      yield* sql`UPDATE routines SET created_at=${at - 60_000}, time_zone=${timeZone} WHERE id=${routineId}`
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
      yield* store.save({ id: routineId, expectedRevision: null, name: 'Inbox', prompt: 'Original prompt', agent: 'pi', model, skillIds: [], integrationIds: ['lark'], resourceIds: ['lark/im'], intervalMinutes: 30, timeZone: 'UTC', enabled: true })
      const first = (yield* store.schedule(routineId, Date.parse('2026-09-11T10:00:00Z')))!
      yield* store.save({ id: routineId, expectedRevision: 1, name: 'Inbox', prompt: 'New prompt', agent: 'codex', model: null, skillIds: [], integrationIds: [], resourceIds: [], intervalMinutes: 30, timeZone: 'America/Los_Angeles', enabled: true })
      const task = yield* (yield* HarnessStore).task(first.taskId)
      expect(task.goal).toBe('Original prompt')
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

  it('normalizes resource lists and preserves save idempotency', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      yield* setup
      const store = yield* RoutineStore
      const previous = yield* store.get(routineId)
      const { revision, createdAt: _created, updatedAt: _updated, nextTriggerAt: _next, lastTriggerAt: _last, ...input } = previous
      const updated = { ...input, expectedRevision: revision, resourceIds: ['lark/im', 'lark/im'] }
      const saved = yield* store.save(updated)
      expect(yield* store.save({ ...updated, resourceIds: ['lark/im'] })).toEqual(saved)
      expect(yield* store.save({ ...updated, prompt: 'different' }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
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
