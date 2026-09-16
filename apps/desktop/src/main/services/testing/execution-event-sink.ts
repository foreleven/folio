import { Effect, Layer } from 'effect'
import { ExecutionEventSink } from '../execution-event-sink'
import { HarnessStore } from '../harness-store'
import { HarnessEventStore } from '../harness-event-store'

/** Protocol-only fixtures predate queue admission; production always uses the durable event bus. */
export const protocolTestSink = Layer.effect(ExecutionEventSink, Effect.gen(function* () {
  const store = yield* HarnessStore
  const events = yield* HarnessEventStore
  return ExecutionEventSink.of({
    bindSession: store.bindSession, reserveRun: store.reserveRun, markRunning: store.markRunning,
    finishRun: store.finishRun, appendUpdate: events.appendUpdate, appendProtocol: events.appendProtocol,
    appendProtocolDiagnostic: events.appendProtocolDiagnostic, flush: Effect.void,
    processStarted: () => Effect.void, processStopped: () => Effect.void,
    finishRequest: () => Effect.die('Protocol-only fixtures must not finish queue requests.')
  })
}))
