import { reserveClaimedRun, markClaimedRunning, finishClaimedRun } from './claimed-run'
import { Effect, Layer } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { ExecutionEventSink } from '../execution/execution-event-sink'
import { HarnessStoreError } from '../../../shared/harness'
import { HarnessStore } from '../harness/harness-store'
import { HarnessEventStore } from '../harness/harness-event-store'

/** Protocol-only fixtures predate queue admission; production uses claimed Runs and recovery files. */
export const protocolTestSink = Layer.effect(ExecutionEventSink, Effect.gen(function* () {
  const store = yield* HarnessStore
  const events = yield* HarnessEventStore
  const sql = yield* SqlClient.SqlClient
  return ExecutionEventSink.of({
    guard: () => Effect.succeed(effect => effect),
    cancellation: () => Effect.void,
    begin: () => Effect.void, workerStarting: () => Effect.void,
    bindSession: store.bindSession, reserveRun: input => reserveClaimedRun(input).pipe(Effect.provideService(HarnessStore, store), Effect.provideService(SqlClient.SqlClient, sql)), markRunning: id => markClaimedRunning(id).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    finishRun: (id, outcome, error) => Effect.gen(function* () {
      const run = (yield* sql<{ sessionId: string }>`SELECT session_id AS sessionId FROM runs WHERE id=${id}`)[0]
      if (run) yield* events.finishSession(run.sessionId)
      yield* finishClaimedRun(id, outcome, error).pipe(Effect.provideService(SqlClient.SqlClient, sql))
    }).pipe(Effect.mapError(error => error instanceof HarnessStoreError ? error : new HarnessStoreError({ reason: 'storage', message: 'Could not finish test run.' }))), appendUpdate: events.appendUpdate,
    flush: Effect.void,
    workerStarted: () => Effect.void, workerStopped: () => Effect.void,
    processStarted: () => Effect.void, processStopped: () => Effect.void,
    finishRequest: () => Effect.die('Protocol-only fixtures must not finish queue requests.')
  })
}))
