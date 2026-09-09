import { Effect, Exit, Semaphore } from 'effect'
import { resolve } from 'node:path'
import { IntegrationError } from './integration.ts'
import type { CheckResult, Integration, IntegrationContext, IntegrationDefinition, IntegrationEffect } from './integration.ts'

/** Wraps provider hooks with one shared lifecycle; each provider owns its own lock and live progress. */
export function defineIntegration<C extends IntegrationContext = IntegrationContext>(definition: IntegrationDefinition<C>): Integration<C> {
  const active = new Map<string, { token: symbol; result: CheckResult }>()
  const lock = Semaphore.makeUnsafe(1)
  /** Unknown provider failures must not leak credential-bearing SDK/transport diagnostics. */
  const sanitize = (cause: unknown) => cause instanceof IntegrationError ? cause
    : new IntegrationError({ message: 'Could not complete the integration operation. Check files and connectivity.' })

  /** Publishes only persisted progress, then checks facts; all exit paths release live state. */
  const run = Effect.fn('Integration.run')(function*(context: C, operation: (context: C) => IntegrationEffect<void, unknown>) {
    const key = resolve(context.directory)
    const token = Symbol(definition.id)
    const tracked: C = {
      ...context,
      writeState: (state, data) => Effect.suspend(() => {
        // A late callback from a completed attempt must not replace a newer attempt's state.
        if (active.get(key)?.token !== token) return Effect.void
        return context.writeState(state, data).pipe(Effect.tap(() => Effect.sync(() => {
          if (active.get(key)?.token === token) active.set(key, { token, result: { state, actionIds: [] } })
        })))
      })
    }
    active.set(key, { token, result: { state: 'working', actionIds: [] } })
    yield* Effect.gen(function*() {
      yield* operation(tracked)
      const result = yield* definition.check(tracked)
      yield* tracked.writeState(result.state, { actionIds: result.actionIds })
    }).pipe(
      Effect.onExit((exit) => Exit.isFailure(exit)
        ? context.writeState(Exit.hasInterrupts(exit) ? 'cancelled' : 'action_failed', {}) : Effect.void),
      // Effect failure does not unwind a generator's JavaScript finally block.
      // Cleanup must run even if publishing the failure itself cannot be persisted.
      Effect.ensuring(Effect.sync(() => { active.delete(key) }))
    )
  })

  /** Starts only explicitly confirmed installation, then publishes a checked state. */
  const install = Effect.fn('Integration.install')(function*(context: C) {
    yield* run(context, definition.install)
  }, lock.withPermit, Effect.mapError(sanitize))

  /** Read-only and nonblocking even while an action is waiting for a user callback. */
  const check = Effect.fn('Integration.check')(function*(context: C) {
    return active.get(resolve(context.directory))?.result ?? (yield* definition.check(context))
  }, Effect.mapError(sanitize))

  /** Revalidates actions under the provider lock, so queued duplicate callbacks become stale. */
  const onActionCallback = Effect.fn('Integration.onActionCallback')(function*(context: C, actionId: string, payload?: unknown) {
    if (!definition.actions.some((action) => action.id === actionId)) {
      return yield* new IntegrationError({ message: 'Unknown integration action.' })
    }
    const current = yield* definition.check(context)
    if (!current.actionIds.includes(actionId)) {
      return yield* new IntegrationError({ message: 'This integration action is no longer available. Check again.' })
    }
    yield* run(context, (tracked) => definition.onActionCallback(tracked, actionId, payload))
  }, lock.withPermit, Effect.mapError(sanitize))

  return { ...definition, install, check, onActionCallback }
}
