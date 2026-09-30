import { WikiService } from '../../shared/wiki-service'
import { Context, Effect, Layer } from 'effect'
import { RpcTest } from 'effect/unstable/rpc'
import { expect, it } from 'vitest'
import { ExecutionRpcs } from '../../shared/rpc/execution-rpc'
import { emptyTaskCounts, HarnessStoreError } from '../../shared/harness'
import { ConfigService } from '../services/config/config-service'
import { VaultContext } from '../services/vault/vault-context'
import { VaultRuntime } from '../services/vault/vault-runtime'
import { TaskService } from '../services/tasks/task-service'
import { ExecutionRpcHandlersLive } from './execution-rpc'

it('aggregates unopened Vaults and marks unavailable Vaults without hiding healthy counts', async () => {
  const opened: string[] = []
  const config = Layer.succeed(ConfigService)({
    get: Effect.succeed({ vaults: [{ id: 'a' }, { id: 'b' }, { id: 'offline' }], executionConcurrency: 3 })
  } as unknown as ConfigService['Service'])
  const runtimes = Layer.succeed(VaultRuntime)({
      withClosed: (_id, operation) => operation,
    open: id => {
      opened.push(id)
      if (id === 'offline') return Effect.fail(new HarnessStoreError({ reason: 'storage', message: 'offline' }))
      return Effect.succeed(Context.make(TaskService, {
        taskCounts: Effect.succeed({ ...emptyTaskCounts(), queued: id === 'a' ? 2 : 1, running: 1, pending: 1, completed: 3, conflict: id === 'a' ? 1 : 0 }),
        executionCounts: Effect.die('Task status must not count historical Runs')
      } as unknown as TaskService['Service']).pipe(Context.add(VaultContext, { id, vault: { id, name: id, path: '/test' }, directory: '/test' }), Context.add(WikiService, {} as WikiService['Service'])))
    }
  })
  const result = await Effect.runPromise(Effect.gen(function* () {
    const client = yield* RpcTest.makeClient(ExecutionRpcs)
    return yield* client['executions.status']()
  }).pipe(Effect.provide(ExecutionRpcHandlersLive.pipe(Layer.provide([config, runtimes]))), Effect.scoped))
  expect(opened.sort()).toEqual(['a', 'b', 'offline'])
  expect(result).toEqual({ ...emptyTaskCounts(), queued: 3, running: 2, pending: 2, completed: 6, conflict: 1, concurrency: 3, vaults: 3, unavailableVaults: 1 })
})
