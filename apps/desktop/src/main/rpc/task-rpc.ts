import { Effect } from 'effect'
import { TaskRpcs } from '../../shared/rpc/task-rpc'
import { TaskService } from '../services/task-service'

/** Task storage and worktree operations remain in the application service, beyond renderer lifetimes. */
export const TaskRpcHandlersLive = TaskRpcs.toLayer(
  Effect.succeed(TaskRpcs.of({
      'workspace.changes': () => Effect.flatMap(TaskService, (service) => service.workspace.inspect),
      'workspace.diff': ({ input }) => Effect.flatMap(TaskService, (service) => service.workspace.diff(input)),
      'workspace.saveFiles': ({ input }) => Effect.flatMap(TaskService, (service) => service.saveWorkspaceFiles(input)),
      'routines.list': () => Effect.flatMap(TaskService, (service) => service.routines),
      'routines.allExecutions': () => Effect.flatMap(TaskService, (service) => service.allRoutineExecutions),
      'routines.executions': ({ routineId }) => Effect.flatMap(TaskService, (service) => service.routineExecutions(routineId)),
      'routines.save': ({ input }) => Effect.flatMap(TaskService, (service) => service.saveRoutine(input)),
      'routines.run': ({ input }) => Effect.flatMap(TaskService, (service) => service.runRoutine(input)),
      'routines.prepare': ({ input }) => Effect.flatMap(TaskService, (service) => service.prepareRoutine(input)),
      'tasks.list': () => Effect.flatMap(TaskService, (service) => service.list),
      'tasks.create': (input) => Effect.flatMap(TaskService, (service) => service.create(input)),
      'tasks.complete': ({ taskId }) => Effect.flatMap(TaskService, (service) => service.complete(taskId)),
      'tasks.reopen': ({ taskId }) => Effect.flatMap(TaskService, (service) => service.reopen(taskId)),
      'tasks.wikiChanges': ({ taskId }) => Effect.flatMap(TaskService, (service) => service.workspace.inspectTaskWiki(taskId)),
      'tasks.wikiDiff': ({ taskId, input }) => Effect.flatMap(TaskService, (service) => service.workspace.diffTaskWiki(taskId, input)),
      'tasks.wikiConflictContext': ({ taskId, id }) => Effect.flatMap(TaskService, (service) => service.taskWikiConflictContext(taskId, id)),
      'tasks.saveWikiFiles': ({ input }) => Effect.flatMap(TaskService, (service) => service.saveTaskWikiFiles(input)),
      'tasks.saveRunWikiFiles': ({ input }) => Effect.flatMap(TaskService, (service) => service.saveRunWikiFiles(input)),
      'tasks.confirmRunWikiUnchanged': ({ input }) => Effect.flatMap(TaskService, (service) => service.confirmRunWikiUnchanged(input)),
      'tasks.synchronizeWiki': ({ input }) => Effect.flatMap(TaskService, (service) => service.synchronizeTaskWiki(input)),
      'tasks.reprepareWiki': ({ input }) => Effect.flatMap(TaskService, (service) => service.reprepareTaskWiki(input)),
      'tasks.resolveWikiConflict': ({ taskId, id }) => Effect.flatMap(TaskService, (service) => service.resolveTaskWikiConflict(taskId, id)),
      'tasks.abortWikiConflict': ({ taskId, id }) => Effect.flatMap(TaskService, (service) => service.abortTaskWikiConflict(taskId, id)),
      'tasks.pendingSynchronizations': ({ taskId }) => Effect.flatMap(TaskService, (service) => service.pendingTaskSynchronizations(taskId)),
      'tasks.synchronization': ({ id }) => Effect.flatMap(TaskService, (service) => service.taskSynchronization(id)),
      'tasks.sessionHistory': ({ taskId, sessionId }) => Effect.flatMap(TaskService, (service) => service.history(taskId, sessionId)),
      'tasks.startRun': (input) => Effect.flatMap(TaskService, (service) => service.startRun(input)),
      'tasks.startConflictResolution': (input) => Effect.flatMap(TaskService, (service) => service.startConflictResolution(input)),
      'tasks.inspectRun': ({ taskId, runId }) => Effect.flatMap(TaskService, (service) => service.inspectRun(taskId, runId)),
      'tasks.cancelRun': ({ taskId, runId }) => Effect.flatMap(TaskService, (service) => service.cancelRun(taskId, runId)),
      'tasks.get': ({ id }) => Effect.flatMap(TaskService, (service) => service.get(id)),
      'tasks.openSession': (input) => Effect.flatMap(TaskService, (service) => service.openSession(input)),
      'tasks.closeSession': ({ taskId, sessionId }) => Effect.flatMap(TaskService, (service) => service.closeSession(taskId, sessionId))
    }))
)
