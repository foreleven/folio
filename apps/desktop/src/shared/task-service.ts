import type { ExecutionCounts } from './execution'
import { Context, Effect } from 'effect'
import type { HarnessStoreError, SessionRecord, TaskRecord, RunRecord } from './harness'
import type { RunRoutine, SaveRoutine, RoutineRecord, RoutineExecution, ScheduledRoutineExecution } from './routine'
import type { CreateTaskInput, OpenTaskSessionInput, StartConflictResolutionInput, StartTaskRunInput, RetryKnowledgeRunInput, TaskDetail, SessionHistory, RoutineRunResult, TaskFeedPage, TaskFeedCursor } from './rpc/task-rpc'
import type {
  ConfirmRunWikiUnchanged,
  SaveRunWikiFiles,
  SaveTaskWikiFiles,
  SaveWorkspaceFiles,
  GitConflictContext,
  GitConflictFile,
  GitChangeApplication,
  ReprepareTaskWiki,
  SynchronizeTaskWiki,
  GitSyncOperation,
  WorkspaceChangesView,
  WorkspaceDiffInput,
  WorkspaceFileDiff,
  WriteGitConflictResolution
} from './git-change'

/** Services for one Vault; identity comes from its main-owned context. */
export class TaskService extends Context.Service<
  TaskService,
  {
    readonly workspace: {
      readonly inspect: Effect.Effect<WorkspaceChangesView, HarnessStoreError>
      readonly diff: (input: WorkspaceDiffInput) => Effect.Effect<WorkspaceFileDiff, HarnessStoreError>
      readonly inspectTaskWiki: (taskId: string) => Effect.Effect<WorkspaceChangesView, HarnessStoreError>
      readonly diffTaskWiki: (taskId: string, input: WorkspaceDiffInput) => Effect.Effect<WorkspaceFileDiff, HarnessStoreError>
    }
    readonly taskWikiConflictContext: (taskId: string, id: string) => Effect.Effect<typeof GitConflictContext.Type, HarnessStoreError>
    readonly taskWikiConflictFiles: (taskId: string, id: string) => Effect.Effect<readonly GitConflictFile[], HarnessStoreError>
    readonly writeTaskWikiConflictResolution: (input: WriteGitConflictResolution) => Effect.Effect<void, HarnessStoreError>
    readonly saveWorkspaceFiles: (input: SaveWorkspaceFiles) => Effect.Effect<GitChangeApplication, HarnessStoreError>
    readonly saveTaskWikiFiles: (input: SaveTaskWikiFiles) => Effect.Effect<GitChangeApplication, HarnessStoreError>
    readonly saveRunWikiFiles: (input: SaveRunWikiFiles) => Effect.Effect<GitChangeApplication, HarnessStoreError>
    readonly confirmRunWikiUnchanged: (input: ConfirmRunWikiUnchanged) => Effect.Effect<RunRecord, HarnessStoreError>
    readonly synchronizeTaskWiki: (input: SynchronizeTaskWiki) => Effect.Effect<GitSyncOperation, HarnessStoreError>
    readonly reprepareTaskWiki: (input: ReprepareTaskWiki) => Effect.Effect<GitSyncOperation, HarnessStoreError>
    readonly resolveTaskWikiConflict: (taskId: string, id: string) => Effect.Effect<GitSyncOperation, HarnessStoreError>
    readonly abortTaskWikiConflict: (taskId: string, id: string) => Effect.Effect<GitSyncOperation, HarnessStoreError>
    readonly cancelIngestion: (taskId: string) => Effect.Effect<TaskRecord, HarnessStoreError>
    readonly retryIngestion: (taskId: string) => Effect.Effect<TaskRecord, HarnessStoreError>
    readonly pendingTaskSynchronizations: (taskId: string) => Effect.Effect<readonly GitSyncOperation[], HarnessStoreError>
    readonly taskSynchronization: (id: string) => Effect.Effect<GitSyncOperation, HarnessStoreError>
    readonly executionCounts: Effect.Effect<ExecutionCounts, HarnessStoreError>
    readonly claimExecution: (owner: string) => Effect.Effect<RunRecord | null, HarnessStoreError>
    readonly recoverExecutionState: Effect.Effect<number, HarnessStoreError>
    readonly executeRequest: (request: RunRecord) => Effect.Effect<void, HarnessStoreError>
    readonly tickRoutines: Effect.Effect<void, HarnessStoreError>
    readonly list: Effect.Effect<readonly TaskRecord[], HarnessStoreError>
    readonly feed: (cursor: TaskFeedCursor | null) => Effect.Effect<TaskFeedPage, HarnessStoreError>
    readonly allRoutineExecutions: Effect.Effect<readonly RoutineExecution[], HarnessStoreError>
    readonly routineExecutions: (id: string) => Effect.Effect<readonly RoutineExecution[], HarnessStoreError>
    readonly dispatchRoutine: (id: string) => Effect.Effect<RoutineRunResult | null, HarnessStoreError>
    readonly routines: Effect.Effect<readonly RoutineRecord[], HarnessStoreError>
    readonly ensureDefaultRoutine: Effect.Effect<void, HarnessStoreError>
    readonly saveRoutine: (input: SaveRoutine) => Effect.Effect<RoutineRecord, HarnessStoreError>
    readonly runRoutine: (input: RunRoutine) => Effect.Effect<RoutineRunResult, HarnessStoreError>
    readonly prepareRoutine: (input: RunRoutine) => Effect.Effect<{ execution: ScheduledRoutineExecution; task: TaskRecord }, HarnessStoreError>
    readonly create: (input: CreateTaskInput) => Effect.Effect<TaskRecord, HarnessStoreError>
    readonly complete: (taskId: string) => Effect.Effect<TaskRecord, HarnessStoreError>
    readonly reopen: (taskId: string) => Effect.Effect<TaskRecord, HarnessStoreError>
    readonly get: (id: string) => Effect.Effect<TaskDetail, HarnessStoreError>
    readonly history: (taskId: string, sessionId: string) => Effect.Effect<SessionHistory, HarnessStoreError>
    readonly startRun: (input: StartTaskRunInput) => Effect.Effect<RunRecord, HarnessStoreError>
    readonly retryKnowledgeRun: (input: RetryKnowledgeRunInput) => Effect.Effect<RunRecord, HarnessStoreError>
    readonly startConflictResolution: (input: StartConflictResolutionInput) => Effect.Effect<RunRecord, HarnessStoreError>
    readonly inspectRun: (taskId: string, runId: string) => Effect.Effect<RunRecord, HarnessStoreError>
    readonly cancelRun: (taskId: string, runId: string) => Effect.Effect<RunRecord, HarnessStoreError>
    readonly openSession: (input: OpenTaskSessionInput) => Effect.Effect<SessionRecord, HarnessStoreError>
    readonly closeSession: (taskId: string, sessionId: string) => Effect.Effect<void, HarnessStoreError>
  }
>()('folio/services/TaskService') {}
