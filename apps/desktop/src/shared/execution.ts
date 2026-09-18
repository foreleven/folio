import { Schema } from 'effect'
import { RunIntent } from './harness'

/** Durable admission is independent of an Agent process or a verified Git baseline. */
export const ExecutionSubmission = Schema.Struct({
  ...RunIntent.fields,
  source: Schema.Literals(['manual', 'routine', 'recovery', 'conflict-resolution'])
})
export type ExecutionSubmission = typeof ExecutionSubmission.Type

export { RunRecord } from './harness'

/** Counts execution attempts, including historical terminal outcomes, without transferring prompts. */
export const ExecutionCounts = Schema.Struct({
  queued: Schema.Number, preparing: Schema.Number, running: Schema.Number,
  succeeded: Schema.Number, failed: Schema.Number, cancelled: Schema.Number, interrupted: Schema.Number
})
export type ExecutionCounts = typeof ExecutionCounts.Type
export const emptyExecutionCounts = (): { -readonly [K in keyof ExecutionCounts]: number } => ({
  queued: 0, preparing: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0, interrupted: 0
})
export const GlobalExecutionStatus = Schema.Struct({
  ...ExecutionCounts.fields,
  vaults: Schema.Number,
  unavailableVaults: Schema.Number,
  concurrency: Schema.Number
})
