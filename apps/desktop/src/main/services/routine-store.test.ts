import { NodeServices } from '@effect/platform-node'
import { TaskWorktrees } from './task-worktrees'
import { ExecutionQueue } from './execution-queue'
import { HarnessStore } from './harness-store'
import { SqlClient } from 'effect/unstable/sql'
import { Effect, Layer } from 'effect'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RoutineStore } from './routine-store'
import { vaultDatabaseLayer } from './vault-database'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'folio-routine-store-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const layer = () => RoutineStore.layer.pipe(Layer.provide(TaskWorktrees.layer(root)), Layer.provideMerge(Layer.merge(HarnessStore.layer, ExecutionQueue.layer)), Layer.provideMerge(vaultDatabaseLayer(root)), Layer.provide(NodeServices.layer))
const routineId = '11111111-1111-4111-8111-111111111111'

const setup = Effect.gen(function* () {
  const store = yield* RoutineStore
  yield* store.save({ id: routineId, expectedRevision: null, name: 'Inbox', prompt: 'Process today', agent: 'codex', model: null, skillIds: [], integrationIds: ['lark'], resourceIds: ['lark/im'], intervalMinutes: 30, timeZone: 'UTC', enabled: true })
})

describe('RoutineStore execution coalescing', () => {
  it('retains the reserved model and civil timezone when the Routine is edited', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* RoutineStore
      const model = { providerId: 'anthropic', modelId: 'original-model', thinkingLevel: 'off' as const }
      const input = { id: routineId, expectedRevision: null, name: 'Inbox', prompt: 'Original prompt',
        agent: 'pi' as const, model, skillIds: [], integrationIds: ['lark'], resourceIds: ['lark/im'],
        intervalMinutes: 30, timeZone: 'UTC', enabled: true }
      yield* store.save(input)
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE routines SET created_at=${Date.parse('2026-09-11T00:00:00Z')} WHERE id=${routineId}`
      const first = yield* store.schedule(routineId, Date.parse('2026-09-11T23:30:00Z'))
      yield* store.save({ ...input, expectedRevision: 1, prompt: 'New prompt', agent: 'codex', model: null,
        integrationIds: [], resourceIds: [], timeZone: 'America/Los_Angeles' })
      const end = yield* store.schedule(routineId, Date.parse('2026-09-12T00:05:00Z'))
      expect(end).toMatchObject({ taskId: first.taskId, routineRevision: 1, model, timeZone: 'UTC',
        routineDate: '2026-09-11', isEnd: true, windowEnd: Date.parse('2026-09-11T23:59:59.999Z') })
      expect(yield* (yield* HarnessStore).task(first.taskId)).toMatchObject({ goal: 'Original prompt',
        configuration: { agent: 'pi', integrationIds: ['lark'], resourceIds: ['lark/im'] } })
    }).pipe(Effect.provide(layer())))
  })

  it('retries identical saves independently of property order and normalized resource lists', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* RoutineStore
      const input = { id: routineId, expectedRevision: null, name: 'Inbox', prompt: 'Read mail',
        agent: 'codex' as const, model: null, skillIds: [], integrationIds: ['lark', 'lark'],
        intervalMinutes: 30, resourceIds: ['lark/im', 'lark/im'], timeZone: 'UTC', enabled: true }
      const first = yield* store.save(input)
      expect(yield* store.save({ ...input, integrationIds: ['lark'], resourceIds: ['lark/im'] })).toEqual(first)
      const updated = { ...input, expectedRevision: first.revision, prompt: 'Updated prompt' }
      const second = yield* store.save(updated)
      expect(second.revision).toBe(2)
      expect(yield* store.save(updated)).toEqual(second)
      expect(yield* store.save({ ...updated, prompt: 'Conflicting edit' }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    }).pipe(Effect.provide(layer())))
  })

  it('stores windows only on Tasks and keeps admitted windows immutable through retries', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      yield* setup
      const store = yield* RoutineStore
      const tasks = yield* HarnessStore
      const queue = yield* ExecutionQueue
      const sql = yield* SqlClient.SqlClient
      const at = Date.parse('2026-09-11T10:00:00.000Z')
      const definition = yield* store.get(routineId)
      expect(definition).not.toHaveProperty('modelProviderId')
      expect(definition).not.toHaveProperty('modelId')
      expect(definition).not.toHaveProperty('thinkingLevel')
      const first = yield* store.schedule(routineId, at)
      expect(first).not.toHaveProperty('id')
      expect(yield* tasks.tasks).toHaveLength(1)
      expect(yield* sql`SELECT name FROM sqlite_master WHERE name='routine_executions'`).toHaveLength(0)
      const task = yield* tasks.task(first.taskId)
      expect(task).toMatchObject({ goal: 'Process today', state: 'active', worktreeState: 'pending',
        configuration: { integrationIds: ['lark'], resourceIds: ['lark/im'] } })
      yield* tasks.createSession({ id: 'session', taskId: task.id, agent: 'codex', adapterVersion: '1', purpose: 'task', syncOperationId: null })
      const submit = (id: string) => queue.submit({ id, taskId: task.id, sessionId: 'session', prompt: 'fixed window',
        purpose: 'execution', resumesRunId: null, source: 'routine' })
      yield* submit('first')
      expect(yield* store.schedule(routineId, at + 60_000)).toMatchObject({ taskId: first.taskId, triggerTime: at, triggerCount: 1, status: 'pending' })
      yield* queue.claim('owner')
      expect(yield* store.executionForTask(task.id)).toMatchObject({ status: 'preparing' })
      yield* sql`UPDATE runs SET baseline_commit='verified' WHERE id='first'`
      yield* queue.running('first', 'owner')
      expect(yield* store.executionForTask(task.id)).toMatchObject({ status: 'running' })
      yield* queue.finish('first', 'owner', 'failed')
      expect(yield* store.executionForTask(task.id)).toMatchObject({ status: 'failed' })
      expect(yield* store.schedule(routineId, at + 120_000)).toMatchObject({ taskId: first.taskId, triggerTime: at + 120_000, triggerCount: 2 })
      yield* submit('retry')
      expect(yield* store.executionForTask(task.id)).toMatchObject({ status: 'pending', startedAt: null, endedAt: null })
      yield* queue.cancel('retry')
      expect(yield* store.executionForTask(task.id)).toMatchObject({ status: 'cancelled' })
      expect((yield* store.schedule(routineId, at + 180_000)).taskId).toBe(first.taskId)
      yield* submit('success')
      yield* queue.claim('owner2')
      yield* sql`UPDATE runs SET baseline_commit='verified' WHERE id='success'`
      yield* queue.finish('success', 'owner2', 'succeeded')
      expect(yield* store.executionForTask(task.id)).toMatchObject({ status: 'succeeded' })
      // Execution success does not bypass Git settlement and complete the Task.
      expect((yield* tasks.task(task.id)).state).toBe('active')
      expect((yield* store.schedule(routineId, at + 240_000)).taskId).not.toBe(first.taskId)
      expect(yield* tasks.tasks).toHaveLength(2)
    }).pipe(Effect.provide(layer())))
  })

  it('keeps a day-end window fixed on later ticks and starts the next window at its end', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      yield* setup
      const sql = yield* SqlClient.SqlClient
      const store = yield* RoutineStore
      const tasks = yield* HarnessStore
      const queue = yield* ExecutionQueue
      yield* sql`UPDATE routines SET created_at=${Date.parse('2026-09-11T00:00:00Z')} WHERE id=${routineId}`
      const end = yield* store.schedule(routineId, Date.parse('2026-09-12T00:05:00Z'))
      expect(end.isEnd).toBe(true)
      const repeated = yield* store.schedule(routineId, Date.parse('2026-09-12T00:35:00Z'))
      expect(repeated).toMatchObject({ taskId: end.taskId, triggerTime: end.triggerTime, windowEnd: end.windowEnd })
      yield* tasks.createSession({ id: 'end-session', taskId: end.taskId, agent: 'codex', adapterVersion: '1', purpose: 'task', syncOperationId: null })
      yield* queue.submit({ id: 'end-run', taskId: end.taskId, sessionId: 'end-session', prompt: 'day-end', purpose: 'execution', resumesRunId: null, source: 'routine' })
      yield* queue.claim('end-owner')
      yield* sql`UPDATE runs SET baseline_commit='verified' WHERE id='end-run'`
      yield* queue.finish('end-run', 'end-owner', 'succeeded')
      const next = yield* store.schedule(routineId, Date.parse('2026-09-12T01:05:00Z'))
      expect(next.isEnd).toBe(false)
      expect(next.windowStart).toBe(end.windowEnd)
      expect(next.windowEnd).toBe(Date.parse('2026-09-12T01:05:00Z'))
    }).pipe(Effect.provide(layer())))
  })

  it('rolls back Task reservation when its scheduling metadata cannot be saved', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      yield* setup
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TRIGGER reject_window BEFORE UPDATE OF routine_id ON tasks
        BEGIN SELECT RAISE(ABORT, 'fixture window failure'); END`
      const store = yield* RoutineStore
      expect(yield* store.schedule(routineId).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
      expect(yield* sql`SELECT id FROM tasks`).toHaveLength(0)
      expect((yield* store.get(routineId)).lastTriggerAt).toBeNull()
    }).pipe(Effect.provide(layer())))
  })

  it('updates one same-day execution and upgrades it on the next day close', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      yield* setup
      const store = yield* RoutineStore
      expect((yield* store.get(routineId)).resourceIds).toEqual(['lark/im'])
      const first = yield* store.schedule(routineId, Date.parse('2026-09-11T10:00:00.000Z'))
      const second = yield* store.schedule(routineId, Date.parse('2026-09-11T10:30:00.000Z'))
      expect(second.taskId).toBe(first.taskId)
      expect(second.triggerCount).toBe(2)
      expect(second.routineDate).toBe('2026-09-11')
      const end = yield* store.schedule(routineId, Date.parse('2026-09-12T00:05:00.000Z'))
      expect(end.taskId).toBe(first.taskId)
      expect(end.isEnd).toBe(true)
      expect(end.routineDate).toBe('2026-09-11')
      expect(end.triggerTime).toBe(Date.parse('2026-09-11T23:59:59.999Z'))
      expect(yield* store.executions(routineId)).toHaveLength(1)
    }).pipe(Effect.provide(layer())))
  })

  it('does not create a catch-up queue while an old execution remains unhandled', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      yield* setup
      const store = yield* RoutineStore
      const first = yield* store.schedule(routineId, Date.parse('2026-09-11T10:00:00.000Z'))
      const resumed = yield* store.schedule(routineId, Date.parse('2026-09-14T10:00:00.000Z'))
      expect(resumed.taskId).toBe(first.taskId)
      expect(resumed.triggerCount).toBe(2)
      expect(yield* store.executions(routineId)).toHaveLength(1)
    }).pipe(Effect.provide(layer())))
  })
})
