import { AtomRpc } from 'effect/unstable/reactivity'
import { TaskRpcs } from '../../../shared/rpc/task-rpc'
import { ElectronRpcProtocolLive } from './electron-rpc-protocol'

/** Task queries share the existing Electron transport; mutations never send local filesystem paths. */
export class TaskRpcClient extends AtomRpc.Service<TaskRpcClient>()('folio/renderer/TaskRpcClient', { group: TaskRpcs, protocol: ElectronRpcProtocolLive }) {
  static readonly saveWorkspaceFiles = TaskRpcClient.mutation('workspace.saveFiles')
  static readonly runRoutine = TaskRpcClient.mutation('routines.run')
  static readonly prepareRoutine = TaskRpcClient.mutation('routines.prepare')
  static readonly saveRoutine = TaskRpcClient.mutation('routines.save')
  static readonly saveTaskWikiFiles = TaskRpcClient.mutation('tasks.saveWikiFiles')
  static readonly saveRunWikiFiles = TaskRpcClient.mutation('tasks.saveRunWikiFiles')
  static readonly confirmRunWikiUnchanged = TaskRpcClient.mutation('tasks.confirmRunWikiUnchanged')
  static readonly synchronizeTaskWiki = TaskRpcClient.mutation('tasks.synchronizeWiki')
  static readonly reprepareTaskWiki = TaskRpcClient.mutation('tasks.reprepareWiki')
  static readonly resolveTaskWikiConflict = TaskRpcClient.mutation('tasks.resolveWikiConflict')
  static readonly abortTaskWikiConflict = TaskRpcClient.mutation('tasks.abortWikiConflict')
  static readonly openSession = TaskRpcClient.mutation('tasks.openSession')
  static readonly closeSession = TaskRpcClient.mutation('tasks.closeSession')
  static readonly startRun = TaskRpcClient.mutation('tasks.startRun')
  static readonly startConflictResolution = TaskRpcClient.mutation('tasks.startConflictResolution')
  static readonly inspectRun = TaskRpcClient.mutation('tasks.inspectRun')
  static readonly cancelRun = TaskRpcClient.mutation('tasks.cancelRun')
  static readonly create = TaskRpcClient.mutation('tasks.create')
  static readonly complete = TaskRpcClient.mutation('tasks.complete')
  static readonly reopen = TaskRpcClient.mutation('tasks.reopen')
}
