import { VaultRuntime } from '../vault/vault-runtime'
import { Context, Effect, Layer } from 'effect'
import { ConfigService } from '../config/config-service'
import { TaskService } from '../tasks/task-service'

/** Runs one non-overlapping sweep immediately and every 15 seconds thereafter.
 * Scope interruption stops admission before dependent Task/Session/database resources are released.
 * Sleep/resume and clock changes are reconciled through persisted wall-clock cursors each sweep.
 */
export function routineSchedulerLayer<E, R>(sweep: Effect.Effect<void, E, R>, intervalMs = 15_000) {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      while (true) {
        yield* sweep.pipe(Effect.catch(() => Effect.logWarning('Routine sweep failed; retrying on the next check.')))
        yield* Effect.sleep(intervalMs)
      }
    }).pipe(Effect.forkScoped)
  )
}

/** Queries the registered Vault index afresh so unopened and newly added Vaults are included. */
export const RoutineSchedulerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ConfigService
    const runtimes = yield* VaultRuntime
    return routineSchedulerLayer(
      Effect.gen(function* () {
        const registry = yield* config.get
        yield* Effect.forEach(
          registry.vaults,
          (vault) =>
            runtimes.open(vault.id).pipe(
              Effect.flatMap((context) => Context.get(context, TaskService).tickRoutines),
              Effect.catch(error => Effect.logWarning('A Vault Routine check failed; other Vaults continue.', { vaultId: vault.id }, error))
            ),
          { concurrency: 4, discard: true }
        )
      })
    )
  })
)
