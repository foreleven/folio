import { Schema } from 'effect'
import { NewRun, RunOutcome, SessionBinding } from './harness'
import { RecordedProtocolDiagnostic, RecordedProtocolFrame, RecordedUpdate } from './harness-events'

/** The global journal contains execution facts, never Vault database handles or credentials. */
export const ExecutionEventPayload = Schema.Union([
  Schema.TaggedStruct('worker-started', { ownerPid: Schema.Int, threadId: Schema.Int }),
  Schema.TaggedStruct('worker-stopped', {}),
  Schema.TaggedStruct('process-started', { pid: Schema.Int.check(Schema.isGreaterThan(0)) }),
  Schema.TaggedStruct('process-stopped', { pid: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))) }),
  Schema.TaggedStruct('session-bound', { binding: SessionBinding }),
  Schema.TaggedStruct('run-reserved', { run: NewRun }),
  Schema.TaggedStruct('run-running', {}),
  Schema.TaggedStruct('run-finished', { outcome: RunOutcome, error: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct('request-finished', { outcome: RunOutcome, error: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct('update', { update: RecordedUpdate }),
  Schema.TaggedStruct('protocol', { frame: RecordedProtocolFrame }),
  Schema.TaggedStruct('diagnostic', { diagnostic: RecordedProtocolDiagnostic })
])
export type ExecutionEventPayload = typeof ExecutionEventPayload.Type

/** Main supplies the identity envelope from the claimed request, never from renderer input. */
export const ExecutionEventInput = Schema.Struct({
  eventId: Schema.NonEmptyString,
  vaultId: Schema.NonEmptyString,
  taskId: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  attemptId: Schema.NonEmptyString,
  payload: ExecutionEventPayload
})
export type ExecutionEventInput = typeof ExecutionEventInput.Type
export const ExecutionEvent = Schema.Struct({
  ...ExecutionEventInput.fields,
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  createdAt: Schema.Number
})
export type ExecutionEvent = typeof ExecutionEvent.Type
