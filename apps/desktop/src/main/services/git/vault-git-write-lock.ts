import { SqliteClient } from '@effect/sql-sqlite-node'
import { Context, Effect, Layer } from 'effect'
import { Reactivity } from 'effect/unstable/reactivity'
import { join } from 'node:path'
import { HarnessStoreError } from '../../../shared/harness'

/**
 * Uses SQLite's process-owned write lock, released by the OS on process exit. A separate file
 * keeps Git latency out of the event database. There is no age-based lease takeover, and a
 * competing process fails immediately instead of blocking Node's event loop in busy_timeout.
 */
export class VaultGitWriteLock extends Context.Service<
  VaultGitWriteLock,
  {
    readonly withLock: <A, R>(action: Effect.Effect<A, HarnessStoreError, R>) => Effect.Effect<A, HarnessStoreError, R>
  }
>()('folio/services/VaultGitWriteLock') {
  static layer(directory: string) {
    return Layer.effect(
      VaultGitWriteLock,
      Effect.gen(function* () {
        const client = yield* SqliteClient.make({ filename: join(directory, 'git-write-lock.db'), busyTimeout: 0 })
        const withLock = <A, R>(action: Effect.Effect<A, HarnessStoreError, R>) =>
          client.withTransaction(action).pipe(
            // File/ref mutations must settle before releasing the process-owned gate on cancellation.
            Effect.uninterruptible,
            Effect.mapError((error) =>
              error instanceof HarnessStoreError
                ? error
                : new HarnessStoreError({
                    reason: 'task-busy',
                    message: 'Another Git write is in progress. Retry when it finishes.'
                  })
            )
          )
        return VaultGitWriteLock.of({ withLock })
      })
    ).pipe(Layer.provide(Reactivity.layer))
  }
}
