import { Context, Effect, Layer } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { randomUUID } from 'node:crypto'
import type { ExecutionRequest } from '../../shared/execution'
import type { ExecutionEventPayload } from '../../shared/execution-events'
import { HarnessStoreError } from '../../shared/harness'
import { HarnessStore } from './harness-store'
import { HarnessEventStore } from './harness-event-store'
import { ExecutionEventLog } from './execution-event-log'
import { ExecutionQueue } from './execution-queue'
import { VaultContext } from './vault-context'
import { VaultExecutionEvents } from './vault-execution-events'

/** Agent ingress publishes facts; only the Vault subscriber owns message/database projections. */
export class ExecutionEventSink extends Context.Service<ExecutionEventSink,
  Pick<HarnessStore['Service'], 'bindSession' | 'reserveRun' | 'markRunning' | 'finishRun'> &
  Pick<HarnessEventStore['Service'], 'appendUpdate' | 'appendProtocol' | 'appendProtocolDiagnostic'> & {
    readonly flush: Effect.Effect<void, HarnessStoreError>
    readonly workerStarted: (sessionId: string, threadId: number) => Effect.Effect<void, HarnessStoreError>
    readonly workerStopped: (sessionId: string) => Effect.Effect<void, HarnessStoreError>
    readonly processStarted: (sessionId: string, pid: number) => Effect.Effect<void, HarnessStoreError>
    readonly processStopped: (sessionId: string, pid?: number) => Effect.Effect<void, HarnessStoreError>
    readonly finishRequest: (request: ExecutionRequest, outcome: 'succeeded' | 'failed' | 'cancelled' | 'interrupted', error?: string) => Effect.Effect<void, HarnessStoreError>
  }
>()('folio/services/ExecutionEventSink') {
  static readonly layer = Layer.effect(ExecutionEventSink, Effect.gen(function* () {
    const vault = yield* VaultContext
    const queue = yield* ExecutionQueue
    const log = yield* ExecutionEventLog
    const subscriber = yield* VaultExecutionEvents
    const messages = yield* HarnessEventStore
    const sql = yield* SqlClient.SqlClient
    const invalid = () => new HarnessStoreError({ reason: 'invalid-state', message: 'No claimed execution owns this Agent event.' })
    const active = (id: string, bySession: boolean) => Effect.gen(function* () {
      const request = (yield* queue.list()).find(value => (bySession ? value.sessionId === id : value.id === id)
        && value.owner !== null && value.endedAt === null)
      if (!request) return yield* invalid()
      return request
    })
    const publish = (request: ExecutionRequest, payload: ExecutionEventPayload, eventId: string = randomUUID()) => Effect.gen(function* () {
      if (!request.owner) return yield* invalid()
      yield* log.append({ eventId, vaultId: vault.id, taskId: request.taskId, sessionId: request.sessionId,
        runId: request.id, attemptId: request.owner, payload })
    })
    const emit = (id: string, bySession: boolean, payload: ExecutionEventPayload, stable: boolean | string = false, project = true) => Effect.gen(function* () {
      const request = yield* active(id, bySession)
      yield* publish(request, payload, stable ? `${request.owner}:${typeof stable === 'string' ? stable : payload._tag}` : undefined)
      if (project) yield* subscriber.drain
    })
    return ExecutionEventSink.of({
      flush: subscriber.drain,
      workerStarted: (id, threadId) => emit(id, true, { _tag: 'worker-started', ownerPid: process.pid, threadId }, true),
      workerStopped: id => emit(id, true, { _tag: 'worker-stopped' }, true, false),
      processStarted: (id, pid) => emit(id, true, { _tag: 'process-started', pid }, `process-started:${pid}`),
      processStopped: (id, pid) => emit(id, true, { _tag: 'process-stopped', ...(pid === undefined ? {} : { pid }) }, pid === undefined ? true : `process-stopped:${pid}`, false),
      bindSession: (id, binding) => emit(id, true, { _tag: 'session-bound', binding }, true),
      reserveRun: run => emit(run.id, false, { _tag: 'run-reserved', run }, true),
      markRunning: id => emit(id, false, { _tag: 'run-running' }, true, false),
      finishRun: (id, outcome, error) => emit(id, false, { _tag: 'run-finished', outcome, error: error ?? null }, true, false),
      appendUpdate: update => Effect.gen(function* () {
        const previous = yield* messages.lastSequence(update.sessionId).pipe(Effect.catch(() => Effect.succeed(0)))
        yield* emit(update.sessionId, true, { _tag: 'update', update }, false, false)
        return { duplicate: previous >= update.notification._meta['folio/eventSequence'] }
      }),
      appendProtocol: frame => emit(frame.sessionId, true, { _tag: 'protocol', frame }, false, false),
      appendProtocolDiagnostic: diagnostic => emit(diagnostic.sessionId, true, { _tag: 'diagnostic', diagnostic }, false, false),
      // The receipt survives local projection failure, including failures before a Run existed.
      finishRequest: (request, outcome, error) => Effect.gen(function* () {
        yield* subscriber.drain
        const workers = yield* sql<{ stopped: number }>`SELECT stopped FROM execution_workers WHERE request_id=${request.id}`
        if (workers.some(worker => !worker.stopped)) return yield* invalid()
        const processes = yield* sql<{ stopped: number }>`SELECT stopped FROM execution_processes WHERE request_id=${request.id}`
        if (processes.some(process => !process.stopped)) return yield* invalid()
        yield* publish(request, { _tag: 'request-finished', outcome, error: error ?? null }, `${request.owner}:request-finished`)
        yield* subscriber.drain
      }).pipe(Effect.mapError(error => error instanceof HarnessStoreError ? error : new HarnessStoreError({ reason: 'storage', message: 'Could not confirm execution cleanup.' })))
    })
  }))
}
