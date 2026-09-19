import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { HarnessStoreError, type NewRun, type RunOutcome } from '../../../shared/harness'
import { ExecutionQueue } from '../execution/execution-queue'
import { HarnessStore } from '../harness/harness-store'

/** Storage fixtures use the same admission/claim boundary as the scheduler before Git preparation. */
export const reserveClaimedRun = Effect.fn('testing.reserveClaimedRun')(function* (input: NewRun) {
  const sql = yield* SqlClient.SqlClient
  const store = yield* HarnessStore
  return yield* sql.withTransaction(Effect.gen(function* () {
    const queue = yield* ExecutionQueue
    const task = yield* store.task(input.taskId)
    if (task.state !== 'active' || task.worktreeState !== 'ready') return yield* new HarnessStoreError({ reason: 'invalid-state', message: 'Fixture Task is not ready.' })
    if ((yield* store.runs(input.taskId)).some(run => run.state === 'preparing' || run.state === 'running')) {
      return yield* new HarnessStoreError({ reason: 'task-busy', message: 'Fixture Task has an active Run.' })
    }
    yield* queue.submit({ ...input, source: input.purpose === 'recovery' ? 'recovery' : 'manual' })
    const claimed = yield* queue.claim(`test-${input.id}`)
    if (claimed?.id !== input.id) return yield* new HarnessStoreError({ reason: 'task-busy', message: 'Fixture Run could not be claimed.' })
    yield* store.reserveRun(input, claimed.owner!)
  }).pipe(Effect.provide(ExecutionQueue.layer), Effect.mapError(error => error instanceof HarnessStoreError ? error : new HarnessStoreError({ reason: 'storage', message: 'Could not prepare fixture Run.' }))))
}, Effect.mapError(error => error instanceof HarnessStoreError ? error : new HarnessStoreError({ reason: 'storage', message: 'Could not prepare fixture Run.' })))

/** Fixture transitions still fence by the owner persisted at claim. */
export const markClaimedRunning = (id: string) => Effect.gen(function* () {
  const queue = yield* ExecutionQueue
  const run = yield* queue.get(id)
  yield* queue.running(id, run.owner ?? '')
}).pipe(Effect.provide(ExecutionQueue.layer))
export const finishClaimedRun = (id: string, outcome: RunOutcome, error?: string) => Effect.gen(function* () {
  const queue = yield* ExecutionQueue
  const run = yield* queue.get(id)
  yield* queue.finish(id, run.owner ?? '', outcome, error)
}).pipe(Effect.provide(ExecutionQueue.layer))
