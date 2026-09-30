import { Context, Effect } from 'effect'
import { ExecutionRpcs } from '../../shared/rpc/execution-rpc'
import { emptyTaskCounts, type TaskCounts } from '../../shared/harness'
import { ConfigService } from '../services/config/config-service'
import { VaultRuntime } from '../services/vault/vault-runtime'
import { TaskService } from '../services/tasks/task-service'

/** Read current Task counts for all registered Vaults, including those without windows. */
export const ExecutionRpcHandlersLive = ExecutionRpcs.toLayer(Effect.gen(function* () {
  const config = yield* ConfigService
  const runtimes = yield* VaultRuntime
  return ExecutionRpcs.of({
    'executions.status': () => Effect.gen(function* () {
      const registry = yield* config.get
      const snapshots = yield* Effect.forEach(registry.vaults, vault => runtimes.open(vault.id).pipe(
        Effect.flatMap(context => Context.get(context, TaskService).taskCounts),
        Effect.catch(() => Effect.succeed(null))
      ), { concurrency: 4 })
      const totals = emptyTaskCounts()
      for (const counts of snapshots) {
        if (!counts) continue
        for (const key of Object.keys(totals) as (keyof TaskCounts)[]) totals[key] += counts[key]
      }
      return { ...totals, vaults: registry.vaults.length, unavailableVaults: snapshots.filter(value => value === null).length,
        concurrency: registry.executionConcurrency ?? 2 }
    })
  })
}))
