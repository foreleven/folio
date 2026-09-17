import { Context, Effect, Layer } from 'effect'
import { RpcTest } from 'effect/unstable/rpc'
import { expect, it } from 'vitest'
import { ExecutionRpcs } from '../../shared/rpc/execution-rpc'
import { emptyExecutionCounts } from '../../shared/execution'
import { HarnessStoreError } from '../../shared/harness'
import { ConfigService } from '../services/config-service'
import { VaultContext } from '../services/vault-context'
import { VaultRuntime } from '../services/vault-runtime'
import { TaskService } from '../services/task-service'
import { ExecutionRpcHandlersLive } from './execution-rpc'

it('aggregates unopened Vaults and marks unavailable Vaults without hiding healthy counts', async () => {
  const opened: string[] = []
  const config = Layer.succeed(ConfigService)({
    get: Effect.succeed({ vaults: [{ id: 'a' }, { id: 'b' }, { id: 'offline' }], executionConcurrency: 3 })
  } as unknown as ConfigService['Service'])
  const runtimes = Layer.succeed(VaultRuntime)({
    open: id => {
      opened.push(id)
      if (id === 'offline') return Effect.fail(new HarnessStoreError({ reason: 'storage', message: 'offline' }))
      return Effect.succeed(Context.make(TaskService, {
        executionCounts: Effect.succeed({ ...emptyExecutionCounts(), queued: id === 'a' ? 2 : 1, running: 1 })
      } as unknown as TaskService['Service']).pipe(Context.add(VaultContext, { id, vault: { id, name: id, path: '/test' }, directory: '/test' })))
    }
  })
  const result = await Effect.runPromise(Effect.gen(function* () {
    const client = yield* RpcTest.makeClient(ExecutionRpcs)
    return yield* client['executions.status']()
  }).pipe(Effect.provide(ExecutionRpcHandlersLive.pipe(Layer.provide([config, runtimes]))), Effect.scoped))
  expect(opened.sort()).toEqual(['a', 'b', 'offline'])
  expect(result).toEqual({ ...emptyExecutionCounts(), queued: 3, running: 2, concurrency: 3, vaults: 3, unavailableVaults: 1 })
})
