import { Context, Effect, Layer } from 'effect'
import { ConfigService } from '../config/config-service'
import { VaultRuntime } from '../vault/vault-runtime'
import { TaskService } from '../tasks/task-service'
import { executionSchedulerLayer, type ExecutionSource } from './execution-scheduler'

/** Includes unopened Vaults. This layer is released before VaultRuntime and its databases. */
export const GlobalExecutionSchedulerLive = Layer.unwrap(Effect.gen(function* () {
  const config = yield* ConfigService
  const runtimes = yield* VaultRuntime
  return executionSchedulerLayer({
    concurrency: config.get.pipe(Effect.map(value => value.executionConcurrency ?? 2)),
    sources: Effect.gen(function* () {
      const sources: ExecutionSource[] = []
      for (const vault of (yield* config.get).vaults) {
        const context = yield* runtimes.open(vault.id).pipe(Effect.catch(() => Effect.succeed(null)))
        if (!context) {
          sources.push({ vaultId: vault.id, occupied: (yield* config.get).executionConcurrency ?? 2, claim: () => Effect.succeed(null), execute: () => Effect.void })
          continue
        }
        const service = Context.get(context, TaskService)
        // Failed recovery must not turn an unknown live worker into a free global slot.
        const occupied = yield* service.recoverExecutionState.pipe(Effect.catch(() => config.get.pipe(Effect.map(value => value.executionConcurrency ?? 2))))
        sources.push({ vaultId: vault.id, occupied, claim: service.claimExecution, execute: service.executeRequest })
      }
      return sources
    })
  })
}))
