import { Deferred, Effect, Fiber } from 'effect'
import { describe, expect, it } from 'vitest'
import { emptyExecutionCounts } from '../../../shared/execution'
import { HarnessStoreError } from '../../../shared/harness'
import type { TaskService } from '../../../shared/task-service'
import { makeTaskOperationLifetime } from './task-operation-lifetime'

/** Only exercised operations are supplied; wrapping also checks nested method groups. */
const service = (patch: Partial<TaskService['Service']> = {}) => ({
  list: Effect.succeed([]), recoverExecutionState: Effect.succeed(0), executionCounts: Effect.succeed(emptyExecutionCounts()), ...patch
}) as TaskService['Service']

describe('Vault Task operation lifetime', () => {
  it('joins in-flight cleanup before retirement and rejects stale callers', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      let cleaned = false
      const lifetime = yield* makeTaskOperationLifetime(service({
        executeRequest: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never), Effect.ensuring(
          Effect.sleep(10).pipe(Effect.andThen(Effect.sync(() => { cleaned = true }))))),
        workspace: { inspect: Effect.die('Retired service must not run'), diff: () => Effect.die('Unexpected diff'), inspectTaskWiki: () => Effect.die('Unexpected inspect'), diffTaskWiki: () => Effect.die('Unexpected diff') }
      }))
      const running = yield* lifetime.service.executeRequest({} as never).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* lifetime.quiesce
      expect(cleaned).toBe(true)
      expect((yield* Fiber.await(running))._tag).toBe('Failure')
      expect(yield* lifetime.service.list.pipe(Effect.flip)).toMatchObject({ reason: 'task-busy' })
      expect(yield* lifetime.service.workspace.inspect.pipe(Effect.flip)).toMatchObject({ reason: 'task-busy' })
    }).pipe(Effect.scoped))
  })

  it('retains recoverable operations when ownership cannot be proven stopped', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const lifetime = yield* makeTaskOperationLifetime(service({ executionCounts: Effect.succeed({ ...emptyExecutionCounts(), running: 1 }) }))
      expect(yield* lifetime.quiesce.pipe(Effect.flip)).toMatchObject({ reason: 'task-busy' })
      expect(yield* lifetime.service.list).toEqual([])
    }).pipe(Effect.scoped))
  })

  it('propagates Session cleanup failures before recovery or deletion', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      let recovered = false
      const lifetime = yield* makeTaskOperationLifetime(service({
        list: Effect.succeed([{ id: 'task' }] as never),
        get: () => Effect.succeed({ sessions: [{ id: 'session' }] } as never),
        closeSession: () => Effect.fail(new HarnessStoreError({ reason: 'storage', message: 'process still alive' })),
        recoverExecutionState: Effect.sync(() => { recovered = true; return 0 })
      }))
      expect(yield* lifetime.quiesce.pipe(Effect.flip)).toMatchObject({ message: 'process still alive' })
      expect(recovered).toBe(false)
    }).pipe(Effect.scoped))
  })
})
