import { RoutineExecution, RoutineRecord, RunRoutine, SaveRoutine } from '../routine'
import { ProjectionRow } from '../harness-events'
import { SessionModelSelection } from '../model'
import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/unstable/rpc'
import { AgentKind, HarnessStoreError, RunIntent, RunRecord, SessionRecord, TaskRecord } from '../harness'
import { Vault } from '../vault'
import {
  ConfirmRunWikiUnchanged,
  GitConflictContext,
  GitChangeApplication,
  GitSyncOperation,
  ReprepareTaskWiki,
  SaveRunWikiFiles,
  SaveTaskWikiFiles,
  SaveWorkspaceFiles,
  SynchronizeTaskWiki,
  WorkspaceChangesView,
  WorkspaceDiffInput,
  WorkspaceFileDiff
} from '../git-change'

const TaskId = Schema.String.check(Schema.isUUID())
export const CreateTaskInput = Schema.Struct({
  vaultId: Vault.fields.id,
  id: TaskId,
  goal: Schema.NonEmptyString.check(Schema.makeFilter((value) => value.trim().length > 0)),
  agent: AgentKind,
  integrationIds: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  resourceIds: Schema.optionalKey(Schema.Array(Schema.NonEmptyString))
})
export type CreateTaskInput = typeof CreateTaskInput.Type
export const TaskDetail = Schema.Struct({
  task: TaskRecord,
  routine: Schema.optionalKey(Schema.NullOr(RoutineExecution)),
  sessions: Schema.Array(SessionRecord),
  runs: Schema.Array(RunRecord)
})
export type TaskDetail = typeof TaskDetail.Type
const SessionIdentity = Schema.Struct({ vaultId: Vault.fields.id, taskId: TaskId, sessionId: TaskId })
export const OpenTaskSessionInput = Schema.Struct({ ...SessionIdentity.fields, agent: AgentKind, model: Schema.optionalKey(SessionModelSelection) })
export type OpenTaskSessionInput = typeof OpenTaskSessionInput.Type
export const StartTaskRunInput = Schema.Struct({
  ...RunIntent.fields,
  vaultId: Vault.fields.id,
  id: TaskId,
  taskId: TaskId,
  sessionId: TaskId,
  prompt: CreateTaskInput.fields.goal,
  purpose: Schema.Literals(['execution', 'recovery']),
  resumesRunId: Schema.NullOr(TaskId)
})
export type StartTaskRunInput = typeof StartTaskRunInput.Type
/** Stable identities for one coordinator Run; main builds the conflict Prompt and execution target. */
export const StartConflictResolutionInput = Schema.Struct({
  vaultId: Vault.fields.id,
  taskId: TaskId,
  operationId: SynchronizeTaskWiki.fields.id,
  sourceSessionId: TaskId,
  sessionId: TaskId,
  runId: TaskId
})
export type StartConflictResolutionInput = typeof StartConflictResolutionInput.Type
export const SessionHistory = Schema.Struct({ messages: Schema.Array(ProjectionRow) })
export type SessionHistory = typeof SessionHistory.Type

export const RoutineRunResult = Schema.Struct({ execution: RoutineExecution, task: TaskRecord, run: RunRecord })
export type RoutineRunResult = typeof RoutineRunResult.Type

/** Renderer supplies identities and intent only; main owns paths, branches and capability snapshots. */
export class TaskRpcs extends RpcGroup.make(
  Rpc.make('workspace.changes', { payload: { vaultId: Vault.fields.id }, success: WorkspaceChangesView, error: HarnessStoreError }),
  Rpc.make('workspace.diff', { payload: { vaultId: Vault.fields.id, input: WorkspaceDiffInput }, success: WorkspaceFileDiff, error: HarnessStoreError }),
  Rpc.make('workspace.saveFiles', { payload: { vaultId: Vault.fields.id, input: SaveWorkspaceFiles }, success: GitChangeApplication, error: HarnessStoreError }),
  Rpc.make('routines.list', { payload: { vaultId: Vault.fields.id }, success: Schema.Array(RoutineRecord), error: HarnessStoreError }),
  Rpc.make('routines.allExecutions', { payload: { vaultId: Vault.fields.id }, success: Schema.Array(RoutineExecution), error: HarnessStoreError }),
  Rpc.make('routines.executions', { payload: { vaultId: Vault.fields.id, routineId: RoutineRecord.fields.id }, success: Schema.Array(RoutineExecution), error: HarnessStoreError }),
  Rpc.make('routines.save', { payload: { vaultId: Vault.fields.id, input: SaveRoutine }, success: RoutineRecord, error: HarnessStoreError }),
  Rpc.make('routines.run', { payload: { vaultId: Vault.fields.id, input: RunRoutine }, success: RoutineRunResult, error: HarnessStoreError }),
  Rpc.make('routines.prepare', {
    payload: { vaultId: Vault.fields.id, input: RunRoutine },
    success: Schema.Struct({ execution: RoutineExecution, task: TaskRecord }),
    error: HarnessStoreError
  }),
  Rpc.make('tasks.list', { payload: { vaultId: Vault.fields.id }, success: Schema.Array(TaskRecord), error: HarnessStoreError }),
  Rpc.make('tasks.create', { payload: CreateTaskInput, success: TaskRecord, error: HarnessStoreError }),
  Rpc.make('tasks.complete', { payload: { vaultId: Vault.fields.id, taskId: TaskId }, success: TaskRecord, error: HarnessStoreError }),
  Rpc.make('tasks.reopen', { payload: { vaultId: Vault.fields.id, taskId: TaskId }, success: TaskRecord, error: HarnessStoreError }),
  Rpc.make('tasks.wikiChanges', { payload: { vaultId: Vault.fields.id, taskId: TaskId }, success: WorkspaceChangesView, error: HarnessStoreError }),
  Rpc.make('tasks.wikiDiff', {
    payload: { vaultId: Vault.fields.id, taskId: TaskId, input: WorkspaceDiffInput },
    success: WorkspaceFileDiff,
    error: HarnessStoreError
  }),
  Rpc.make('tasks.wikiConflictContext', {
    payload: { vaultId: Vault.fields.id, taskId: TaskId, id: SynchronizeTaskWiki.fields.id },
    success: GitConflictContext,
    error: HarnessStoreError
  }),
  Rpc.make('tasks.saveWikiFiles', { payload: { vaultId: Vault.fields.id, input: SaveTaskWikiFiles }, success: GitChangeApplication, error: HarnessStoreError }),
  Rpc.make('tasks.saveRunWikiFiles', { payload: { vaultId: Vault.fields.id, input: SaveRunWikiFiles }, success: GitChangeApplication, error: HarnessStoreError }),
  Rpc.make('tasks.confirmRunWikiUnchanged', {
    payload: { vaultId: Vault.fields.id, input: ConfirmRunWikiUnchanged },
    success: RunRecord,
    error: HarnessStoreError
  }),
  Rpc.make('tasks.synchronizeWiki', { payload: { vaultId: Vault.fields.id, input: SynchronizeTaskWiki }, success: GitSyncOperation, error: HarnessStoreError }),
  Rpc.make('tasks.reprepareWiki', { payload: { vaultId: Vault.fields.id, input: ReprepareTaskWiki }, success: GitSyncOperation, error: HarnessStoreError }),
  Rpc.make('tasks.resolveWikiConflict', {
    payload: { vaultId: Vault.fields.id, taskId: TaskId, id: SynchronizeTaskWiki.fields.id },
    success: GitSyncOperation,
    error: HarnessStoreError
  }),
  Rpc.make('tasks.abortWikiConflict', {
    payload: { vaultId: Vault.fields.id, taskId: TaskId, id: SynchronizeTaskWiki.fields.id },
    success: GitSyncOperation,
    error: HarnessStoreError
  }),
  Rpc.make('tasks.pendingSynchronizations', {
    payload: { vaultId: Vault.fields.id, taskId: TaskId },
    success: Schema.Array(GitSyncOperation),
    error: HarnessStoreError
  }),
  Rpc.make('tasks.synchronization', {
    payload: { vaultId: Vault.fields.id, id: SynchronizeTaskWiki.fields.id },
    success: GitSyncOperation,
    error: HarnessStoreError
  }),
  Rpc.make('tasks.get', { payload: { vaultId: Vault.fields.id, id: TaskId }, success: TaskDetail, error: HarnessStoreError }),
  Rpc.make('tasks.openSession', { payload: OpenTaskSessionInput, success: SessionRecord, error: HarnessStoreError }),
  Rpc.make('tasks.sessionHistory', { payload: SessionIdentity, success: SessionHistory, error: HarnessStoreError }),
  Rpc.make('tasks.startRun', { payload: StartTaskRunInput, success: RunRecord, error: HarnessStoreError }),
  Rpc.make('tasks.startConflictResolution', { payload: StartConflictResolutionInput, success: RunRecord, error: HarnessStoreError }),
  Rpc.make('tasks.inspectRun', { payload: { vaultId: Vault.fields.id, taskId: TaskId, runId: TaskId }, success: RunRecord, error: HarnessStoreError }),
  Rpc.make('tasks.cancelRun', { payload: { vaultId: Vault.fields.id, taskId: TaskId, runId: TaskId }, success: RunRecord, error: HarnessStoreError }),
  Rpc.make('tasks.closeSession', { payload: SessionIdentity, success: Schema.Void, error: HarnessStoreError })
) {}
