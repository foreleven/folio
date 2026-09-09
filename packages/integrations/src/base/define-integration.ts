import { Effect, Exit, Semaphore, Schema } from 'effect'
import { resolve } from 'node:path'
import { IntegrationContext, IntegrationError } from './integration.ts'
import type { CheckResult, Integration, IntegrationDefinition, IntegrationEffect } from './integration.ts'

/** Wraps provider hooks with one shared lifecycle; each provider owns its own lock and live progress. */
export function defineIntegration<R = never>(definition: IntegrationDefinition<R>): Integration<R> {
  const active = new Map<string, { token: symbol; result: CheckResult }>()
  const lock = Semaphore.makeUnsafe(1)
  /** Unknown provider failures must not leak credential-bearing SDK/transport diagnostics. */
  const sanitize = (cause: unknown) => cause instanceof IntegrationError ? cause
    : new IntegrationError({ message: 'Could not complete the integration operation. Check files and connectivity.' })

  /** Publishes only persisted progress, then checks facts; all exit paths release live state. */
  const runOperation = Effect.fn('Integration.runOperation')(function*(operation: IntegrationEffect<void, unknown, R>) {
    const context = yield* IntegrationContext
    const key = resolve(context.directory)
    const token = Symbol(definition.id)
    const tracked = IntegrationContext.of({
      ...context,
      writeState: (state, data, actions = []) => Effect.suspend(() => {
        // A late callback from a completed attempt must not replace a newer attempt's state.
        if (active.get(key)?.token !== token) return Effect.void
        return context.writeState(state, data, actions).pipe(Effect.tap(() => Effect.sync(() => {
          if (active.get(key)?.token === token) active.set(key, { token, result: { state, actions } })
        })))
      })
    })
    active.set(key, { token, result: { state: 'working', actions: [] } })
    yield* Effect.gen(function*() {
      yield* operation
      const result = yield* definition.inspect()
      yield* tracked.writeState(result.state, {}, result.actions)
    }).pipe(
      // Override only host state tracking; preserve every provider-specific service in the environment.
      Effect.provideService(IntegrationContext, tracked),
      Effect.onExit((exit) => Exit.isFailure(exit)
        ? context.writeState(Exit.hasInterrupts(exit) ? 'cancelled' : 'action_failed', {}) : Effect.void),
      // Effect failure does not unwind a generator's JavaScript finally block.
      // Cleanup must run even if publishing the failure itself cannot be persisted.
      Effect.ensuring(Effect.sync(() => { active.delete(key) }))
    )
  })

  /** Starts only explicitly confirmed installation, then publishes a checked state. */
  const install = Effect.fn('Integration.install')(function*() {
    yield* runOperation(Effect.suspend(definition.install))
  }, lock.withPermit, Effect.mapError(sanitize))

  /** Read-only and nonblocking even while an action is waiting for a user callback. */
  const inspect = Effect.fn('Integration.inspect')(function*() {
    const context = yield* IntegrationContext
    return active.get(resolve(context.directory))?.result ?? (yield* definition.inspect())
  }, Effect.mapError(sanitize))

  /** Revalidates actions under the provider lock, so queued duplicate callbacks become stale. */
  const onActionCallback = Effect.fn('Integration.onActionCallback')(function*(actionId: string, payload?: unknown) {
    if (!definition.actions.some((action) => action.id === actionId)) {
      return yield* new IntegrationError({ message: 'Unknown integration action.' })
    }
    const current = yield* definition.inspect()
    if (!current.actions.some((action) => action.id === actionId && action.type === 'callback')) {
      return yield* new IntegrationError({ message: 'This integration action is no longer available. Check again.' })
    }
    const fields = definition.actions.find((action) => action.id === actionId)!.fields
    if (fields?.length) {
      const values = yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.String))(payload).pipe(Effect.mapError(sanitize))
      if (fields.some((field) => field.required && !values[field.id]?.trim())) {
        return yield* new IntegrationError({ message: 'Complete the required fields.' })
      }
    }
    yield* runOperation(Effect.suspend(() => definition.onActionCallback(actionId, payload)))
  }, lock.withPermit, Effect.mapError(sanitize))

  return { ...definition, install, inspect, onActionCallback,
    run: definition.run ? () => Effect.suspend(definition.run!).pipe(Effect.mapError(sanitize)) : undefined }
}
