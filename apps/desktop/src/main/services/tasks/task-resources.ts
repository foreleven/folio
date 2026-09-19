import { Cause, Context, Effect, Layer } from 'effect'
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { HarnessStoreError, type TaskRecord } from '../../../shared/harness'
import { IntegrationService, type PreparedIntegrationResources } from '../integrations/integration-service'

type Mounts = Pick<PreparedIntegrationResources, 'skillPaths' | 'executableDirectories' | 'environment'>
const failure = (message = 'Task resources could not be prepared. Check the selected integrations and try again.') =>
  new HarnessStoreError({ reason: 'storage', message })

/**
 * Uses the current installed Integration assets for every Session. Tasks intentionally
 * follow upgrades; only workspace instructions are materialized, and credentials stay in memory.
 */
export class TaskResources extends Context.Service<TaskResources, {
  readonly prepare: (task: TaskRecord) => Effect.Effect<Mounts, HarnessStoreError>
}>()('folio/services/TaskResources') {
  static readonly layer = Layer.effect(TaskResources, Effect.gen(function*() {
    const integrations = yield* IntegrationService
    const prepare = Effect.fn('TaskResources.prepare')(function*(task: TaskRecord) {
      if (!task.configuration.integrationIds.length) return { skillPaths: [], executableDirectories: [] }
      let stage = 'prepare-integrations'
      return yield* Effect.gen(function*() {
        // Provider checks validate installed paths and refresh authorization for each Session.
        const mounted = yield* integrations.prepare(task.configuration.integrationIds, task.worktree, task.configuration.resourceIds ?? [])
        const workspaceFiles = [
          ...(mounted.workspaceFiles ?? []),
          ...(mounted.instructions.length
            ? [{ path: 'raws/.folio-integration-instructions.md', content: `${mounted.instructions.join('\n\n')}\n` }]
            : [])
        ]
        const writeWorkspaceFiles = async (): Promise<void> => {
          if (!workspaceFiles.length) return
          if (await realpath(task.worktree) !== task.worktree) throw failure(`Task worktree is not canonical: ${task.worktree}`)
          for (const file of workspaceFiles) {
            const path = file.path.replaceAll('\\', '/')
            if (!path.startsWith('raws/') || path.includes('..') || path.startsWith('/') || path.split('/').some(part => !part || part === '.')) throw failure(`Invalid workspace resource path: ${path}`)
            const target = resolve(task.worktree, path)
            const parentDirectory = dirname(target)
            await mkdir(parentDirectory, { recursive: true, mode: 0o700 })
            if (await realpath(parentDirectory) !== parentDirectory) throw failure(`Workspace resource parent is redirected: ${parentDirectory}`)
            await lstat(target).then(info => { if (info.isSymbolicLink()) throw failure(`Workspace resource target is a symbolic link: ${target}`) }).catch(error => {
              if (error?.code !== 'ENOENT') throw error
            })
            await writeFile(target, file.content, { mode: 0o600 })
          }
        }

        stage = 'write-workspace-files'
        yield* Effect.tryPromise(() => writeWorkspaceFiles())
        return { skillPaths: mounted.skillPaths, executableDirectories: mounted.executableDirectories,
          ...(mounted.environment ? { environment: mounted.environment } : {}) }
      }).pipe(Effect.tapCause(cause => Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError(
        'Task resource preparation failed',
        { taskId: task.id, worktree: task.worktree, stage,
          integrationIds: task.configuration.integrationIds, resourceIds: task.configuration.resourceIds ?? [] },
        Cause.pretty(cause)
      )))
    }, Effect.mapError(() => failure()))
    return TaskResources.of({ prepare })
  }))
}
