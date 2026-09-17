import { Context, Effect } from 'effect'
import { ExecutionRpcs } from '../../shared/rpc/execution-rpc'
import { emptyExecutionCounts, type ExecutionCounts } from '../../shared/execution'
import { ConfigService } from '../services/config-service'
import { VaultRuntime } from '../services/vault-runtime'
import { TaskService } from '../services/task-service'

/** Read committed queue counts for all registered Vaults, including those without windows. */
export const ExecutionRpcHandlersLive = ExecutionRpcs.toLayer(Effect.gen(function* () {
  const config = yield* ConfigService
  const runtimes = yield* VaultRuntime
  return ExecutionRpcs.of({
    'executions.status': () => Effect.gen(function* () {
      const registry = yield* config.get
      const snapshots = yield* Effect.forEach(registry.vaults, vault => runtimes.open(vault.id).pipe(
        Effect.flatMap(context => Context.get(context, TaskService).executionCounts),
        Effect.catch(() => Effect.succeed(null))
      ), { concurrency: 4 })
      const totals = emptyExecutionCounts()
      for (const counts of snapshots) {
        if (!counts) continue
        for (const key of Object.keys(totals) as (keyof ExecutionCounts)[]) totals[key] += counts[key]
      }
      return { ...totals, vaults: registry.vaults.length, unavailableVaults: snapshots.filter(value => value === null).length,
        concurrency: registry.executionConcurrency ?? 2 }
    })
  })
}))
