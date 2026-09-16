import { Context, Effect, Layer, Semaphore, Stream } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import type { ExecutionEvent } from '../../shared/execution-events'
import { HarnessStoreError } from '../../shared/harness'
import { VaultContext } from './vault-context'
import { ExecutionEventLog } from './execution-event-log'
import { ExecutionQueue } from './execution-queue'
import { HarnessStore } from './harness-store'
import { HarnessEventStore } from './harness-event-store'
import { RoutineStore } from './routine-store'

const invalid = () => new HarnessStoreError({ reason: 'invalid-state', message: 'Execution event does not belong to this Vault or attempt.' })
const safe = (error: unknown) => error instanceof HarnessStoreError ? error : new HarnessStoreError({ reason: 'storage', message: 'Could not project execution events.' })

/** One application-owned subscriber per Vault, independent of window and Worker lifetime. */
export class VaultExecutionEvents extends Context.Service<VaultExecutionEvents, {
  readonly drain: Effect.Effect<void, HarnessStoreError>
  readonly position: Effect.Effect<number, HarnessStoreError>
}>()('folio/services/VaultExecutionEvents') {
  static readonly layer = Layer.effect(VaultExecutionEvents, Effect.gen(function* () {
    const vault = yield* VaultContext
    const log = yield* ExecutionEventLog
    const queue = yield* ExecutionQueue
    const store = yield* HarnessStore
    const messages = yield* HarnessEventStore
    const routines = yield* RoutineStore
    const sql = yield* SqlClient.SqlClient
    const gate = yield* Semaphore.make(1)
    const position = sql<{ sequence: number }>`SELECT sequence FROM execution_event_cursor WHERE id=1`.pipe(
      Effect.map(rows => rows[0]!.sequence), Effect.mapError(safe))

    /** Apply only the next journal event. Its projection and cursor commit or roll back together. */
    const apply = (event: ExecutionEvent) => sql.withTransaction(Effect.gen(function* () {
      if (event.sequence <= (yield* position)) return
      if (event.vaultId !== vault.id) return yield* invalid()
      const request = yield* queue.get(event.runId)
      if (request.taskId !== event.taskId || request.sessionId !== event.sessionId || request.owner !== event.attemptId) return yield* invalid()
      const payload = event.payload
      switch (payload._tag) {
        case 'process-started':
          yield* sql`INSERT INTO execution_processes (request_id, pid) VALUES (${event.runId}, ${payload.pid})`
          if (yield* routines.executionForTask(event.taskId)) yield* routines.setStatus(event.taskId, 'preparing')
          break
        case 'process-stopped':
          yield* sql`UPDATE execution_processes SET stopped=1 WHERE request_id=${event.runId}`
          break
        case 'session-bound':
          yield* store.bindSession(event.sessionId, payload.binding)
          break
        case 'run-reserved':
          if (payload.run.id !== event.runId || payload.run.taskId !== event.taskId || payload.run.sessionId !== event.sessionId) return yield* invalid()
          yield* store.reserveRun(payload.run)
          if (yield* routines.executionForTask(event.taskId)) yield* routines.setStatus(event.taskId, 'preparing')
          break
        case 'run-running':
          yield* store.markRunning(event.runId)
          if (request.state === 'preparing') yield* queue.running(event.runId, event.attemptId)
          if (yield* routines.executionForTask(event.taskId)) yield* routines.setStatus(event.taskId, 'running')
          break
        case 'run-finished':
          yield* store.finishRun(event.runId, payload.outcome, payload.error ?? undefined)
          break
        case 'request-finished': {
          const run = (yield* store.runs(event.taskId)).find(value => value.id === event.runId)
          if (run?.state === 'preparing' || run?.state === 'running' || (!run && payload.outcome === 'succeeded')) return yield* invalid()
          if ((yield* sql`SELECT request_id FROM execution_processes WHERE request_id=${event.runId} AND stopped=0`).length) return yield* invalid()
          // A previously committed Run receipt wins over a producer's uncertain local read.
          const outcome = run?.state === 'succeeded' ? 'succeeded' : request.cancelRequested ? 'cancelled' : run ? run.state : payload.outcome
          if (request.endedAt === null) yield* queue.finish(event.runId, event.attemptId, outcome, payload.error ?? undefined)
          if (yield* routines.executionForTask(event.taskId)) yield* routines.setStatus(event.taskId, outcome)
          break
        }
        case 'update':
          if (payload.update.sessionId !== event.sessionId || (payload.update.runId !== null && payload.update.runId !== event.runId)) return yield* invalid()
          yield* messages.appendUpdate(payload.update)
          break
        case 'protocol':
          if (payload.frame.sessionId !== event.sessionId) return yield* invalid()
          yield* messages.appendProtocol(payload.frame)
          break
        case 'diagnostic':
          if (payload.diagnostic.sessionId !== event.sessionId) return yield* invalid()
          yield* messages.appendProtocolDiagnostic(payload.diagnostic)
          break
      }
      yield* sql`UPDATE execution_event_cursor SET sequence=${event.sequence} WHERE id=1`
    })).pipe(Effect.mapError(safe))
    const drain = Effect.gen(function* () {
      while (true) {
        const page = yield* log.after(vault.id, yield* position)
        for (const event of page) yield* apply(event)
        if (page.length < 256) return
      }
    }).pipe(gate.withPermit)
    const retryableDrain = drain.pipe(Effect.catch(() => Effect.logWarning('Vault execution projection failed; saved events will be retried.')))
    // Subscribe before initial replay; periodic replay repairs a lost notification at any boundary.
    yield* log.changes.pipe(Stream.filter(id => id === vault.id), Stream.runForEach(() => retryableDrain), Effect.forkScoped)
    yield* Effect.gen(function* () {
      while (true) { yield* retryableDrain; yield* Effect.sleep(1000) }
    }).pipe(Effect.forkScoped)
    return VaultExecutionEvents.of({ drain, position })
  }))
}
