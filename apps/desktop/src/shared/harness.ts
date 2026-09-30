import { ModelProfile } from '@folio/agent/config/schema'
import { Schema } from 'effect'
import { SessionModelSelection } from './model'

export const AgentKind = Schema.Literals(['pi', 'codex'])
const Id = Schema.NonEmptyString
const Goal = Schema.NonEmptyString.check(Schema.makeFilter((value) => value.trim().length > 0))
/** Immutable Agent inputs. Credentials remain in Agent and Integration stores. */
export const RawInput = Schema.Struct({ fromCommit: Schema.NullOr(Schema.String), toCommit: Schema.String })
export type RawInput = typeof RawInput.Type
export const AgentTaskConfiguration = Schema.Struct({
  goal: Goal,
  agent: AgentKind,
  model: Schema.NullOr(SessionModelSelection),
  skillIds: Schema.Array(Id),
  integrationIds: Schema.Array(Id),
  resourceIds: Schema.Array(Id),
  rawInput: Schema.NullOr(RawInput)
})
export type AgentTaskConfiguration = typeof AgentTaskConfiguration.Type
export const IngestionTaskConfiguration = Schema.Struct({
  integrationId: Id,
  resourceId: Id
})
export type IngestionTaskConfiguration = typeof IngestionTaskConfiguration.Type
export const TaskConfiguration = Schema.Union([AgentTaskConfiguration, IngestionTaskConfiguration])
export type TaskConfiguration = typeof TaskConfiguration.Type

export const IngestionReceiptState = Schema.Literals(['pending', 'running', 'succeeded', 'failed', 'interrupted', 'cancelled', 'conflict'])
export const IngestionReceipt = Schema.Struct({
  state: IngestionReceiptState,
  attemptCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  cancelRequested: Schema.Boolean,
  startedAt: Schema.NullOr(Schema.Number),
  endedAt: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String),
  changeId: Schema.NullOr(Id),
  observedHead: Schema.NullOr(Schema.String)
})
export type IngestionReceipt = typeof IngestionReceipt.Type

/** Task-level result snapshots survive later edits to the source raws projection. */
export const TaskPublication = Schema.Struct({
  state: Schema.Literals(['pending', 'not-required', 'completed', 'conflict', 'failed']),
  saveOperationId: Schema.NullOr(Id), synchronizationId: Schema.NullOr(Id)
})
export const TaskSummary = Schema.Union([
  Schema.Struct({ type: Schema.Literal('agent'), runId: Id, runSequence: Schema.Int, endedAt: Schema.Number,
    outcome: Schema.Literals(['succeeded', 'failed', 'interrupted', 'cancelled']), error: Schema.NullOr(Schema.String),
    discovery: Schema.NullOr(Schema.Struct({ content: Schema.Array(Schema.Json), incomplete: Schema.Boolean })), publication: TaskPublication }),
  Schema.Struct({ type: Schema.Literal('ingestion'), windowStart: Schema.Number, windowEnd: Schema.Number,
    timeZone: Schema.String, attemptCount: Schema.Int, endedAt: Schema.Number,
    outcome: Schema.Literals(['succeeded', 'failed', 'interrupted', 'cancelled', 'conflict']), error: Schema.NullOr(Schema.String),
    rawsChanged: Schema.Boolean, changedFileCount: Schema.Int, publication: TaskPublication })
])
export type TaskSummary = typeof TaskSummary.Type

const TaskIdentity = {
  id: Id
}
export const NewTask = Schema.Union([
  Schema.Struct({ ...TaskIdentity, type: Schema.Literal('agent'), configuration: AgentTaskConfiguration, receipt: Schema.Null }),
  Schema.Struct({ ...TaskIdentity, type: Schema.Literal('ingestion'), configuration: IngestionTaskConfiguration, receipt: IngestionReceipt })
])
export type NewTask = typeof NewTask.Type
const TaskLifecycle = {
  // These are derived from the Vault directory and Task id; they are exposed for consumers but
  // are deliberately not persisted in the Task row.
  branch: Id,
  worktree: Id,
  state: Schema.Literals(['active', 'completed', 'cancelled']),
  worktreeState: Schema.Literals(['pending', 'creating', 'ready', 'releasing', 'released']),
  worktreeBase: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(TaskSummary),
  createdAt: Schema.Number
}
export const TaskRecord = Schema.Union([
  Schema.Struct({ ...TaskIdentity, ...TaskLifecycle, type: Schema.Literal('agent'), configuration: AgentTaskConfiguration, receipt: Schema.Null }),
  Schema.Struct({ ...TaskIdentity, ...TaskLifecycle, type: Schema.Literal('ingestion'), configuration: IngestionTaskConfiguration, receipt: IngestionReceipt })
])
export type TaskRecord = typeof TaskRecord.Type

/** One current status per Task; successful Runs alone do not complete their Task. */
export const TaskStatus = Schema.Literals(['pending', 'queued', 'preparing', 'running', 'completed', 'failed', 'interrupted', 'cancelled', 'conflict'])
export const TaskCounts = Schema.Struct({
  pending: Schema.Number, queued: Schema.Number, preparing: Schema.Number, running: Schema.Number,
  completed: Schema.Number, failed: Schema.Number, interrupted: Schema.Number, cancelled: Schema.Number, conflict: Schema.Number
})
export type TaskCounts = typeof TaskCounts.Type
export const emptyTaskCounts = (): { -readonly [K in keyof TaskCounts]: number } => ({
  pending: 0, queued: 0, preparing: 0, running: 0, completed: 0, failed: 0, interrupted: 0, cancelled: 0, conflict: 0
})

export const SessionPurpose = Schema.Literals(['task', 'conflict-resolution'])
const SessionIdentity = {
  id: Id,
  taskId: Id,
  agent: AgentKind,
  adapterVersion: Id,
  purpose: SessionPurpose,
  syncOperationId: Schema.NullOr(Id)
}
export const NewSession = Schema.Struct({ ...SessionIdentity,
  modelProfile: Schema.optionalKey(Schema.NullOr(ModelProfile)) })
export type NewSession = typeof NewSession.Type
export const SessionBinding = Schema.Struct({
  acpSessionId: Id, nativeSessionId: Schema.NullOr(Id)
})
export type SessionBinding = typeof SessionBinding.Type
export const SessionRecord = Schema.Struct({
  ...SessionIdentity, modelProfile: Schema.optionalKey(Schema.NullOr(ModelProfile)),
  acpSessionId: Schema.NullOr(Id), nativeSessionId: Schema.NullOr(Id), createdAt: Schema.Number
})
export type SessionRecord = typeof SessionRecord.Type

/** Preparing already reserves the worktree. A prompt acknowledgement is not a terminal result. */
export const RunState = Schema.Literals(['queued', 'preparing', 'running', 'succeeded', 'failed', 'interrupted', 'cancelled'])
export const RunOutcome = Schema.Literals(['succeeded', 'failed', 'interrupted', 'cancelled'])
export type RunOutcome = typeof RunOutcome.Type
export const NewRun = Schema.Struct({
  id: Id, taskId: Id, sessionId: Id, prompt: Schema.NonEmptyString,
  purpose: Schema.Literals(['execution', 'recovery', 'conflict-resolution']),
  resumesRunId: Schema.NullOr(Id), baselineCommit: Id
})
export type NewRun = typeof NewRun.Type
/** Renderer intent omits the Git baseline, which only main can verify. */
export const RunIntent = Schema.Struct({
  id: NewRun.fields.id, taskId: NewRun.fields.taskId, sessionId: NewRun.fields.sessionId,
  prompt: NewRun.fields.prompt, purpose: NewRun.fields.purpose, resumesRunId: NewRun.fields.resumesRunId
})
export type RunIntent = typeof RunIntent.Type
export const RunRecord = Schema.Struct({
  ...NewRun.fields, baselineCommit: Schema.NullOr(Id), state: RunState,
  sequence: Schema.Number,
  source: Schema.Literals(['manual', 'routine', 'recovery', 'conflict-resolution']),
  owner: Schema.NullOr(Schema.String), cancelRequested: Schema.Boolean,
  startedAt: Schema.NullOr(Schema.Number),
  syncState: Schema.Literals(['not-required', 'pending', 'syncing', 'conflict', 'completed', 'failed']),
  createdAt: Schema.Number, endedAt: Schema.NullOr(Schema.Number), error: Schema.NullOr(Schema.String)
})
export type RunRecord = typeof RunRecord.Type

/** Stable failures exposed without SQL, filesystem diagnostics, or prompt contents. */
export class HarnessStoreError extends Schema.TaggedError<HarnessStoreError>()('HarnessStoreError', {
  reason: Schema.Literals(['storage', 'not-found', 'invalid-state', 'task-busy', 'routine-busy', 'routine-conflict']), message: Schema.String
}) {}
