import { randomUUID } from 'node:crypto'
import { Context, Effect, Layer, Queue } from 'effect'
import type { RunRecord } from '../../shared/execution'
import type { HarnessStoreError } from '../../shared/harness'

/** Notifications are hints only. A periodic database sweep repairs missed notifications. */
export class ExecutionNotifications extends Context.Service<ExecutionNotifications, {
  readonly wake: Effect.Effect<void>
  readonly wait: Effect.Effect<void>
}>()('folio/services/ExecutionNotifications') {
  static readonly layer = Layer.effect(ExecutionNotifications, Effect.gen(function* () {
    const queue = yield* Queue.dropping<void>(1)
    return ExecutionNotifications.of({ wake: Queue.offer(queue, undefined).pipe(Effect.asVoid), wait: Queue.take(queue) })
  }))
}

export interface ExecutionSource {
  readonly vaultId: string
  /** Unreconciled previous-process workers consume capacity until their exit is proven. */
  readonly occupied?: number
  readonly claim: (owner: string) => Effect.Effect<RunRecord | null, HarnessStoreError>
  /** Must finish process cleanup and persist the terminal receipt before returning. */
  readonly execute: (request: RunRecord) => Effect.Effect<void, HarnessStoreError>
}

/**
 * One application-owned dispatcher assigns slots across all Vaults. A slot covers the complete
 * worker scope, including cancellation finalizers. The caller must provide Vault resources outside
 * this layer so shutdown joins workers before closing their databases.
 */
export function executionSchedulerLayer<E, R>(options: {
  readonly sources: Effect.Effect<readonly ExecutionSource[], E, R>
  readonly concurrency: Effect.Effect<number, E, R>
  readonly intervalMs?: number
}) {
  return Layer.effectDiscard(Effect.gen(function* () {
    const notifications = yield* ExecutionNotifications
    let active = 0
    let lastVault: string | undefined
    const sweep = Effect.gen(function* () {
      const limit = yield* options.concurrency
      if (!Number.isInteger(limit) || limit < 1) {
        yield* Effect.logWarning('Execution concurrency must be a positive integer; admission is paused.')
        return
      }
      if (active >= limit) return
      const sources = yield* options.sources
      const occupied = sources.reduce((count, source) => count + (source.occupied ?? 0), 0)
      const previous = sources.findIndex(source => source.vaultId === lastVault)
      let cursor = previous < 0 ? 0 : (previous + 1) % sources.length
      let misses = 0
      while (active + occupied < limit && sources.length && misses < sources.length) {
        const source = sources[cursor]!
        cursor = (cursor + 1) % sources.length
        const request = yield* source.claim(randomUUID()).pipe(Effect.catch(() => {
          return Effect.logWarning('A Vault execution queue could not be read; other Vaults continue.').pipe(Effect.as(null))
        }))
        if (!request) { misses++; continue }
        misses = 0
        lastVault = source.vaultId
        active++
        yield* source.execute(request).pipe(
          Effect.catchCause(() => Effect.logWarning('Execution worker stopped; its persisted ownership requires reconciliation.')),
          Effect.ensuring(Effect.sync(() => { active-- }).pipe(Effect.andThen(notifications.wake))),
          Effect.forkScoped
        )
      }
    })
    yield* Effect.gen(function* () {
      while (true) {
        yield* sweep.pipe(Effect.catch(() => Effect.logWarning('Execution queue sweep failed; retrying.')))
        yield* Effect.raceFirst(notifications.wait, Effect.sleep(options.intervalMs ?? 1000))
      }
    }).pipe(Effect.forkScoped)
  }))
}
