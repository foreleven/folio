import { Effect } from 'effect'
import { TaskRpcs } from '../../shared/rpc/task-rpc'
import { TaskService } from '../services/task-service'

/** Task storage and worktree operations remain in the application service, beyond renderer lifetimes. */
export const TaskRpcHandlersLive = TaskRpcs.toLayer(
  Effect.gen(function* () {
    const service = yield* TaskService
    return TaskRpcs.of({
      'workspace.changes': ({ vaultId }) => service.workspaceChanges(vaultId),
      'workspace.diff': ({ vaultId, input }) => service.workspaceDiff(vaultId, input),
      'workspace.saveFiles': ({ vaultId, input }) => service.saveWorkspaceFiles(vaultId, input),
      'routines.list': ({ vaultId }) => service.listRoutines(vaultId),
      'routines.allExecutions': ({ vaultId }) => service.allRoutineExecutions(vaultId),
      'routines.executions': ({ vaultId, routineId }) => service.routineExecutions(vaultId, routineId),
      'routines.save': ({ vaultId, input }) => service.saveRoutine(vaultId, input),
      'routines.run': ({ vaultId, input }) => service.runRoutine(vaultId, input),
      'routines.prepare': ({ vaultId, input }) => service.prepareRoutine(vaultId, input),
      'tasks.list': ({ vaultId }) => service.list(vaultId),
      'tasks.create': (input) => service.create(input),
      'tasks.complete': ({ vaultId, taskId }) => service.complete(vaultId, taskId),
      'tasks.reopen': ({ vaultId, taskId }) => service.reopen(vaultId, taskId),
      'tasks.wikiChanges': ({ vaultId, taskId }) => service.taskWikiChanges(vaultId, taskId),
      'tasks.wikiDiff': ({ vaultId, taskId, input }) => service.taskWikiDiff(vaultId, taskId, input),
      'tasks.wikiConflictContext': ({ vaultId, taskId, id }) => service.taskWikiConflictContext(vaultId, taskId, id),
      'tasks.saveWikiFiles': ({ vaultId, input }) => service.saveTaskWikiFiles(vaultId, input),
      'tasks.saveRunWikiFiles': ({ vaultId, input }) => service.saveRunWikiFiles(vaultId, input),
      'tasks.confirmRunWikiUnchanged': ({ vaultId, input }) => service.confirmRunWikiUnchanged(vaultId, input),
      'tasks.synchronizeWiki': ({ vaultId, input }) => service.synchronizeTaskWiki(vaultId, input),
      'tasks.reprepareWiki': ({ vaultId, input }) => service.reprepareTaskWiki(vaultId, input),
      'tasks.resolveWikiConflict': ({ vaultId, taskId, id }) => service.resolveTaskWikiConflict(vaultId, taskId, id),
      'tasks.abortWikiConflict': ({ vaultId, taskId, id }) => service.abortTaskWikiConflict(vaultId, taskId, id),
      'tasks.pendingSynchronizations': ({ vaultId, taskId }) => service.pendingTaskSynchronizations(vaultId, taskId),
      'tasks.synchronization': ({ vaultId, id }) => service.taskSynchronization(vaultId, id),
      'tasks.sessionHistory': ({ vaultId, taskId, sessionId }) => service.history(vaultId, taskId, sessionId),
      'tasks.startRun': (input) => service.startRun(input),
      'tasks.startConflictResolution': (input) => service.startConflictResolution(input),
      'tasks.inspectRun': ({ vaultId, taskId, runId }) => service.inspectRun(vaultId, taskId, runId),
      'tasks.cancelRun': ({ vaultId, taskId, runId }) => service.cancelRun(vaultId, taskId, runId),
      'tasks.get': ({ vaultId, id }) => service.get(vaultId, id),
      'tasks.openSession': (input) => service.openSession(input),
      'tasks.closeSession': ({ vaultId, taskId, sessionId }) => service.closeSession(vaultId, taskId, sessionId)
    })
  })
)
