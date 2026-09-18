import { Effect, Fiber, FiberSet } from 'effect'
import { HarnessStoreError } from '../../shared/harness'
import type { TaskService } from '../../shared/task-service'

const unavailable = () => new HarnessStoreError({ reason: 'task-busy', message: 'This Vault is closing. Wait for deletion to finish.' })

/**
 * Every public Task operation, including calls through an old window/scheduler reference,
 * belongs to the Vault lifetime. Draining joins cleanup before SQLite or files can disappear.
 */
export const makeTaskOperationLifetime = (raw: TaskService['Service'], verifyStopped: Effect.Effect<void, HarnessStoreError> = Effect.void) => Effect.gen(function* () {
  const fibers = yield* FiberSet.make<unknown, HarnessStoreError>()
  let closing = false
  const track = <A>(operation: Effect.Effect<A, HarnessStoreError>) => Effect.uninterruptibleMask(restore => Effect.gen(function* () {
    if (closing) return yield* unavailable()
    // Register before any user operation can run or awaken a concurrent deletion.
    const fiber = yield* Effect.forkDetach(operation, { startImmediately: false })
    yield* FiberSet.add(fibers, fiber)
    return yield* restore(Fiber.join(fiber)).pipe(Effect.ensuring(Fiber.interrupt(fiber)))
  }))
  // TaskService contains only Effects, Effect-returning methods and the workspace
  // method group. Traverse that contract so new methods cannot bypass retirement.
  const wrap = (value: unknown): unknown => {
    if (Effect.isEffect(value)) return track(value as Effect.Effect<unknown, HarnessStoreError>)
    if (typeof value === 'function') return (...args: unknown[]) => track(Effect.suspend(() => value(...args)))
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, wrap(entry)]))
    throw new Error('Unsupported TaskService operation')
  }
  const service = wrap(raw) as TaskService['Service']
  yield* Effect.addFinalizer(() => Effect.sync(() => { closing = true }))
  const quiesce = Effect.gen(function* () {
    closing = true
    yield* FiberSet.clear(fibers)
    // Idle Sessions may own native processes too. Close them explicitly while their
    // database and recovery services are still alive, and propagate cleanup failures.
    for (const task of yield* raw.list) {
      for (const session of (yield* raw.get(task.id)).sessions) yield* raw.closeSession(task.id, session.id)
    }
    yield* raw.recoverExecutionState
    yield* verifyStopped
    const counts = yield* raw.executionCounts
    if (counts.preparing || counts.running) return yield* new HarnessStoreError({
      reason: 'task-busy', message: 'Vault execution ownership could not be released. Stop or inspect its tasks before deleting.'
    })
  }).pipe(Effect.uninterruptible, Effect.onError(() => Effect.sync(() => { closing = false })))
  return { service, quiesce }
})
