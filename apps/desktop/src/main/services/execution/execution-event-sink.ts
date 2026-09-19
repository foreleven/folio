import { Context, Effect, Layer } from 'effect'
import type { RunRecord, NewRun, RunOutcome } from '../../../shared/harness'
import { HarnessStoreError } from '../../../shared/harness'
import { HarnessStore } from '../harness/harness-store'
import { HarnessEventStore } from '../harness/harness-event-store'
import { ExecutionQueue } from './execution-queue'
import { processIdentity } from './process-identity'
import { RunFiles, fileEffect, type RunFileState } from './run-files'

const invalid = () => new HarnessStoreError({ reason: 'invalid-state', message: 'No claimed execution owns this Agent event.' })

/** Direct Vault writes plus atomic recovery receipts. Diagnostic logs are never replayed. */
export class ExecutionEventSink extends Context.Service<ExecutionEventSink,
  Pick<HarnessStore['Service'], 'bindSession'> &
  Pick<HarnessEventStore['Service'], 'appendUpdate'> & {
    readonly markRunning: (id: string) => Effect.Effect<void, HarnessStoreError>
    readonly finishRun: (id: string, outcome: RunOutcome, error?: string) => Effect.Effect<void, HarnessStoreError>
    readonly reserveRun: (run: NewRun) => Effect.Effect<void, HarnessStoreError>
    readonly guard: (sessionId: string) => Effect.Effect<<A>(effect: Effect.Effect<A, HarnessStoreError>) => Effect.Effect<A, HarnessStoreError>, HarnessStoreError>
    readonly cancellation: (run: RunRecord) => Effect.Effect<void, HarnessStoreError>
    readonly begin: (run: RunRecord) => Effect.Effect<void, HarnessStoreError>
    readonly flush: Effect.Effect<void, HarnessStoreError>
    readonly workerStarting: (sessionId: string) => Effect.Effect<void, HarnessStoreError>
    readonly workerStarted: (sessionId: string, threadId: number) => Effect.Effect<void, HarnessStoreError>
    readonly workerStopped: (sessionId: string) => Effect.Effect<void, HarnessStoreError>
    readonly processStarted: (sessionId: string, pid: number) => Effect.Effect<void, HarnessStoreError>
    readonly processStopped: (sessionId: string, pid?: number) => Effect.Effect<void, HarnessStoreError>
    readonly finishRequest: (run: RunRecord, outcome: 'succeeded' | 'failed' | 'cancelled' | 'interrupted', error?: string) => Effect.Effect<void, HarnessStoreError>
  }
>()('folio/services/ExecutionEventSink') {
  static readonly layer = Layer.effect(ExecutionEventSink, Effect.gen(function* () {
    const queue = yield* ExecutionQueue
    const store = yield* HarnessStore
    const files = yield* RunFiles
    const messages = yield* HarnessEventStore
    const active = (id: string, bySession: boolean) => Effect.gen(function* () {
      const run = (yield* queue.list()).find(value => (bySession ? value.sessionId === id : value.id === id)
        && value.owner !== null && value.endedAt === null && value.state !== 'queued')
      if (!run) return yield* invalid()
      return run
    })
    const change = (id: string, bySession: boolean, event: string, update: (state: RunFileState) => RunFileState) => Effect.gen(function* () {
      const run = yield* active(id, bySession)
      const state = yield* fileEffect(() => files.update(run.id, run.owner!, update))
      yield* Effect.promise(() => files.log(state, event, event === 'agent-result' ? { outcome: state.result?.outcome } : {}))
      return run
    })
    return ExecutionEventSink.of({
      guard: sessionId => Effect.gen(function* () {
        const expected = yield* active(sessionId, true)
        return <A>(effect: Effect.Effect<A, HarnessStoreError>) => Effect.gen(function* () {
          const current = yield* queue.get(expected.id)
          if (current.owner !== expected.owner || current.endedAt !== null) return yield* invalid()
          return yield* effect
        })
      }),
      cancellation: run => Effect.gen(function* () {
        if (!run.owner) return
        const state = yield* fileEffect(() => files.read(run.id, run.owner!))
        if (state) yield* Effect.promise(() => files.log(state, 'cancel-requested'))
      }),
      begin: run => Effect.gen(function* () {
        const current = yield* queue.get(run.id)
        if (current.owner !== run.owner || current.state !== 'preparing') return yield* invalid()
        const state = yield* fileEffect(() => files.begin(current))
        yield* Effect.promise(() => files.log(state, 'claimed'))
      }),
      flush: Effect.promise(() => files.flush()),
      workerStarting: id => change(id, true, 'worker-starting', state => ({ ...state, phase: 'starting', workerStopped: false })).pipe(Effect.asVoid),
      workerStarted: (id, threadId) => change(id, true, 'worker-started', state => ({ ...state, threadId, workerStopped: false, phase: 'active' })).pipe(Effect.asVoid),
      workerStopped: id => change(id, true, 'worker-stopped', state => ({ ...state, workerStopped: true, phase: 'cleaning' })).pipe(Effect.asVoid),
      processStarted: (id, pid) => Effect.gen(function* () {
        const identity = yield* Effect.promise(() => processIdentity(pid))
        yield* change(id, true, 'process-started', state => ({ ...state,
          processes: [...state.processes.filter(value => value.pid !== pid), { pid, stopped: false, identity }] }))
      }),
      processStopped: (id, pid) => change(id, true, 'process-stopped', state => ({ ...state,
        processes: state.processes.map(value => pid === undefined || value.pid === pid ? { ...value, stopped: true } : value) })).pipe(Effect.asVoid),
      bindSession: (id, binding) => Effect.gen(function* () {
        yield* change(id, true, 'session-bound', state => ({ ...state, binding }))
        yield* store.bindSession(id, binding)
      }),
      reserveRun: run => Effect.gen(function* () {
        const current = yield* active(run.id, false)
        yield* store.reserveRun(run, current.owner!)
        const state = yield* fileEffect(() => files.read(run.id, current.owner!))
        if (state) yield* Effect.promise(() => files.log(state, 'prepared'))
      }),
      markRunning: id => Effect.gen(function* () {
        const run = yield* active(id, false)
        yield* queue.running(id, run.owner!)
        const state = yield* fileEffect(() => files.read(run.id, run.owner!))
        if (state) yield* Effect.promise(() => files.log(state, 'running'))
      }),
      // The result stays in a file until all process cleanup is confirmed. SQL continues
      // reserving the Task, even when an Agent has already returned a successful result.
      finishRun: (id, outcome, error) => Effect.gen(function* () {
        const run = yield* active(id, false)
        yield* messages.finishSession(run.sessionId)
        yield* change(id, false, 'agent-result', state => ({ ...state,
          result: state.result?.outcome === 'succeeded' ? state.result : { outcome, error: error ?? null } }))
      }),
      appendUpdate: messages.appendUpdate,
      finishRequest: (run, fallback, error) => Effect.gen(function* () {
        const current = yield* queue.get(run.id)
        if (!run.owner || current.owner !== run.owner) return yield* invalid()
        const state = yield* fileEffect(() => files.read(run.id, run.owner!))
        if (!state || !state.workerStopped || state.processes.some(value => !value.stopped)) return yield* invalid()
        if (current.endedAt === null) {
          const outcome = state.result?.outcome === 'succeeded' ? 'succeeded'
            : current.cancelRequested ? 'cancelled' : state.result?.outcome ?? fallback
          yield* queue.finish(run.id, run.owner, outcome, state.result?.error ?? error).pipe(
            Effect.tapError(() => Effect.promise(async () => { await files.log(state, 'commit-failed'); await files.flush() }))
          )
        }
        yield* Effect.promise(() => files.log(state, 'committed'))
        yield* fileEffect(() => files.remove(run.id, run.owner!))
        const terminal = new Set((yield* queue.list()).filter(value => value.endedAt !== null).map(value => value.id))
        yield* Effect.promise(() => files.prune(terminal))
      })
    })
  }))
}
