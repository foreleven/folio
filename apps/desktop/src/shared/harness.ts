import { ModelProfile } from '@folio/agent/config/schema'
import { Schema } from 'effect'

export const AgentKind = Schema.Literals(['pi', 'codex'])
const Id = Schema.NonEmptyString
/** Only capability references belong in snapshots; credentials remain in Agent/Integration stores. */
export const TaskConfiguration = Schema.Struct({
  agent: AgentKind,
  skillIds: Schema.Array(Id),
  integrationIds: Schema.Array(Id)
})
export const NewTask = Schema.Struct({
  id: Id, goal: Schema.NonEmptyString, configuration: TaskConfiguration,
  branch: Id, worktree: Id
})
export type NewTask = typeof NewTask.Type
export const TaskRecord = Schema.Struct({
  ...NewTask.fields,
  state: Schema.Literals(['active', 'completed', 'cancelled']),
  worktreeState: Schema.Literals(['pending', 'creating', 'ready', 'releasing', 'released']),
  worktreeBase: Schema.NullOr(Schema.String),
  createdAt: Schema.Number
})
export type TaskRecord = typeof TaskRecord.Type

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
export const RunState = Schema.Literals(['preparing', 'running', 'succeeded', 'failed', 'interrupted', 'cancelled'])
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
  ...NewRun.fields, state: RunState,
  syncState: Schema.Literals(['not-required', 'pending', 'syncing', 'conflict', 'completed', 'failed']),
  createdAt: Schema.Number, endedAt: Schema.NullOr(Schema.Number), error: Schema.NullOr(Schema.String)
})
export type RunRecord = typeof RunRecord.Type

/** Stable failures exposed without SQL, filesystem diagnostics, or prompt contents. */
export class HarnessStoreError extends Schema.TaggedError<HarnessStoreError>()('HarnessStoreError', {
  reason: Schema.Literals(['storage', 'not-found', 'invalid-state', 'task-busy', 'routine-busy', 'routine-conflict']), message: Schema.String
}) {}
