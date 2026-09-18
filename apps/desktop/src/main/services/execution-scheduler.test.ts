import { Deferred, Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import type { RunRecord } from '../../shared/execution'
import { ExecutionNotifications, executionSchedulerLayer, type ExecutionSource } from './execution-scheduler'

const request = (id: string, owner: string): RunRecord => ({ id, sequence: 1, taskId: id, sessionId: id,
  prompt: 'notes', purpose: 'execution', resumesRunId: null, source: 'manual', baselineCommit: null, syncState: 'not-required', state: 'preparing', owner,
  cancelRequested: false, createdAt: 0, startedAt: 0, endedAt: null, error: null })

describe('global execution scheduler', () => {
  it('counts unreconciled workers from a previous process before admitting another Vault', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const scanned = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      let occupied = 1
      let claimed = false
      const sources = Effect.gen(function* () {
        yield* Deferred.succeed(scanned, undefined)
        return [
          { vaultId: 'old', occupied, claim: () => Effect.succeed(null), execute: () => Effect.void },
          { vaultId: 'new', claim: (owner: string) => Effect.sync(() => {
            if (claimed) return null
            claimed = true
            return request('new-run', owner)
          }), execute: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)) }
        ]
      })
      const layer = executionSchedulerLayer({ sources, concurrency: Effect.succeed(1) })
        .pipe(Layer.provideMerge(ExecutionNotifications.layer))
      yield* Effect.gen(function* () {
        yield* Deferred.await(scanned)
        expect(claimed).toBe(false)
        occupied = 0
        yield* (yield* ExecutionNotifications).wake
        yield* Deferred.await(started)
        expect(claimed).toBe(true)
      }).pipe(Effect.provide(layer))
    }).pipe(Effect.timeout('5 seconds')))
  })

  it('shares slots across Vaults, rotates fairly and retains a slot through cleanup', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const first = yield* Deferred.make<void>()
      const second = yield* Deferred.make<void>()
      const cleanupStarted = yield* Deferred.make<void>()
      const releaseCleanup = yield* Deferred.make<void>()
      const third = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const order: string[] = []
      let active = 0
      let maximum = 0
      const source = (vaultId: string): ExecutionSource => {
        const pending = [`${vaultId}1`, `${vaultId}2`]
        return {
          vaultId,
          claim: owner => Effect.sync(() => { const id = pending.shift(); return id ? request(id, owner) : null }),
          execute: job => Effect.gen(function* () {
            active++; maximum = Math.max(maximum, active); order.push(job.id)
            if (job.id === 'a1') {
              yield* Deferred.succeed(first, undefined)
              yield* Deferred.await(releaseFirst)
            } else if (job.id === 'b1') {
              yield* Deferred.succeed(second, undefined)
              yield* Effect.never
            } else {
              yield* Deferred.succeed(third, undefined)
              yield* Effect.never
            }
          }).pipe(Effect.ensuring(Effect.gen(function* () {
            if (job.id === 'a1') {
              yield* Deferred.succeed(cleanupStarted, undefined)
              yield* Deferred.await(releaseCleanup)
            }
            active--
          })))
        }
      }
      const sources = [source('a'), source('b')]
      const layer = executionSchedulerLayer({ sources: Effect.succeed(sources), concurrency: Effect.succeed(2) })
        .pipe(Layer.provide(ExecutionNotifications.layer))
      yield* Effect.gen(function* () {
        yield* Deferred.await(first)
        yield* Deferred.await(second)
        expect(order).toEqual(['a1', 'b1'])
        yield* Deferred.succeed(releaseFirst, undefined)
        yield* Deferred.await(cleanupStarted)
        expect(order).toEqual(['a1', 'b1'])
        expect(active).toBe(2)
        yield* Deferred.succeed(releaseCleanup, undefined)
        yield* Deferred.await(third)
        expect(order).toEqual(['a1', 'b1', 'a2'])
        expect(maximum).toBe(2)
      }).pipe(Effect.provide(layer))
      expect(active).toBe(0)
    }).pipe(Effect.timeout('5 seconds')))
  })
})
