import { Effect, Layer } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExecutionQueue } from './execution-queue'
import { HarnessStore } from './harness-store'
import { vaultDatabaseLayer } from './vault-database'
import type { ExecutionSubmission } from '../../shared/execution'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'folio-execution-queue-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const layer = () => Layer.merge(ExecutionQueue.layer, HarnessStore.layer).pipe(Layer.provideMerge(vaultDatabaseLayer(root)))
const input = (id: string, taskId = 'task'): ExecutionSubmission => ({ id, taskId, sessionId: taskId,
  prompt: 'Read notes', purpose: 'execution', resumesRunId: null, source: 'manual' })
/** Unbound Sessions prove admission does not require an Agent connection. */
const setup = (id = 'task') => Effect.gen(function* () {
  const store = yield* HarnessStore
  yield* store.createTask({ id, goal: 'Notes', configuration: { agent: 'pi', skillIds: [], integrationIds: [] },
    branch: `task/${id}`, worktree: `/tasks/${id}` })
  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE tasks SET worktree_state='ready' WHERE id=${id}`
  yield* store.createSession({ id, taskId: id, agent: 'pi', adapterVersion: '1', purpose: 'task', syncOperationId: null })
  yield* sql`UPDATE tasks SET worktree_state='pending' WHERE id=${id}`
})

describe('durable execution queue', () => {
  it('persists before startup, deduplicates intent and survives reopening', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      yield* setup()
      const queue = yield* ExecutionQueue
      const submitted = yield* queue.submit(input('first'))
      expect(submitted).toMatchObject({ state: 'queued', owner: null, startedAt: null })
      expect(yield* queue.submit(input('first'))).toEqual(submitted)
      expect(yield* queue.submit({ ...input('first'), prompt: 'Different' }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      expect(yield* queue.submit({ ...input('other'), sessionId: 'missing' }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      expect(yield* (yield* HarnessStore).runs('task')).toEqual([])
    }).pipe(Effect.provide(layer())))
    await Effect.runPromise(Effect.gen(function* () {
      const queue = yield* ExecutionQueue
      expect(yield* queue.list()).toHaveLength(1)
      expect(yield* queue.claim('worker')).toMatchObject({ id: 'first', state: 'preparing', owner: 'worker' })
    }).pipe(Effect.provide(layer())))
  })

  it('claims once, skips busy Tasks and fences completion by worker ownership', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      yield* setup()
      yield* setup('other')
      const queue = yield* ExecutionQueue
      yield* queue.submit(input('first'))
      yield* queue.submit(input('followup'))
      yield* queue.submit(input('independent', 'other'))
      const claimed = yield* Effect.all([queue.claim('a'), queue.claim('b'), queue.claim('c')], { concurrency: 'unbounded' })
      expect(claimed.filter(Boolean).map(row => row!.id).sort()).toEqual(['first', 'independent'])
      const first = yield* queue.get('first')
      expect(yield* queue.finish('first', 'obsolete-worker', 'succeeded').pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      yield* queue.running('first', first.owner!)
      yield* queue.finish('first', first.owner!, 'succeeded')
      expect(yield* queue.claim('d')).toMatchObject({ id: 'followup', owner: 'd' })
      expect(yield* queue.finish('first', first.owner!, 'failed').pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    }).pipe(Effect.provide(layer())))
  })

  it('cancels queued work immediately but retains active ownership until cleanup', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      yield* setup()
      const queue = yield* ExecutionQueue
      yield* queue.submit(input('queued'))
      expect(yield* queue.cancel('queued')).toMatchObject({ state: 'cancelled', cancelRequested: true })
      expect(yield* queue.claim('worker')).toBeNull()
      yield* queue.submit(input('active'))
      yield* queue.submit(input('later'))
      yield* queue.claim('worker')
      expect(yield* queue.cancel('active')).toMatchObject({ state: 'preparing', owner: 'worker', cancelRequested: true, endedAt: null })
      expect(yield* queue.claim('other-worker')).toBeNull()
      yield* queue.finish('active', 'worker', 'cancelled')
      expect(yield* queue.claim('other-worker')).toMatchObject({ id: 'later' })
    }).pipe(Effect.provide(layer())))
  })
})
