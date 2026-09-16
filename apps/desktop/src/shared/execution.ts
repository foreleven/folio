import { Schema } from 'effect'
import { RunIntent, RunOutcome } from './harness'

/** Durable admission is independent of an Agent process or a verified Git baseline. */
export const ExecutionSubmission = Schema.Struct({
  ...RunIntent.fields,
  source: Schema.Literals(['manual', 'routine', 'recovery', 'conflict-resolution'])
})
export type ExecutionSubmission = typeof ExecutionSubmission.Type

/** The request ID is also the eventual Run ID; retries allocate a new request. */
export const ExecutionRequest = Schema.Struct({
  ...ExecutionSubmission.fields,
  sequence: Schema.Number,
  state: Schema.Literals(['queued', 'preparing', 'running', ...RunOutcome.literals]),
  owner: Schema.NullOr(Schema.String),
  cancelRequested: Schema.Boolean,
  createdAt: Schema.Number,
  startedAt: Schema.NullOr(Schema.Number),
  endedAt: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String)
})
export type ExecutionRequest = typeof ExecutionRequest.Type
