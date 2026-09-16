import { ExecutionEventLog } from './execution-event-log'
import { ExecutionEventSink } from './execution-event-sink'
import { VaultExecutionEvents } from './vault-execution-events'
import { ExecutionQueue } from './execution-queue'
import { ExecutionNotifications } from './execution-scheduler'
import { Context, Effect, FileSystem, Layer, LayerMap, Stream } from 'effect'
import { join } from 'node:path'
import { HarnessStoreError } from '../../shared/harness'
import { VaultContext, makeVaultContext } from './vault-context'
import { TaskService, TaskServiceLive } from './task-service'
import { RoutineStore } from './routine-store'
import { HarnessRuns } from './harness-runs'
import { ModelService } from './model-service'
import { ConfigService } from './config-service'
import { HarnessStore } from './harness-store'
import { IntegrationService } from './integration-service'
import { TaskResources } from './task-resources'
import { TaskWorktrees } from './task-worktrees'
import { vaultDatabaseLayer } from './vault-database'
import { AgentRuntime } from './agent-runtime'
import { HarnessSessions } from './harness-sessions'
import { HarnessEventStore } from './harness-event-store'
import { GitChangeApplications } from './git-change-applications'
import { GitChangeJournal } from './git-change-journal'
import { WorkspaceChanges } from './workspace-changes'
import { TaskGitSynchronization } from './task-git-synchronization'

const failure = (_reason: 'not-found') => new HarnessStoreError({ reason: 'not-found', message: 'Vault is not registered or its storage is unavailable.' })
const safeError = (error: unknown) => (error instanceof HarnessStoreError ? error : new HarnessStoreError({ reason: 'storage', message: 'Could not open Vault services.' }))

/** Application-owned Vault resources survive window closure and are shared with background jobs. */
export class VaultRuntime extends Context.Service<
  VaultRuntime,
  {
    readonly open: (id: string) => Effect.Effect<Context.Context<TaskService | VaultContext>, HarnessStoreError>
  }
>()('folio/services/VaultRuntime') {
  static readonly layer = Layer.effect(
    VaultRuntime,
    Effect.gen(function* () {
      const config = yield* ConfigService
      const eventLog = yield* ExecutionEventLog
      const notifications = yield* ExecutionNotifications
      const fs = yield* FileSystem.FileSystem
      const runtime = yield* AgentRuntime
      const models = yield* ModelService
      const integrations = yield* IntegrationService
      const agentDirectory = models.directory
      const resources = yield* LayerMap.make(
        (id: string) =>
          Layer.unwrap(
            Effect.gen(function* () {
              const current = (yield* config.get).vaults.find((vault) => vault.id === id)
              if (!current) return yield* failure('not-found')
              const context = makeVaultContext(current, config.directory)
              const directory = context.directory
              // Registration owns initialization. A read must not silently create a missing or redirected Vault.
              if ((yield* fs.realPath(directory)) !== directory || !(yield* fs.exists(join(directory, 'data.db')))) return yield* failure('not-found')
              return TaskServiceLive.pipe(
                Layer.provide(WorkspaceChanges.layer(directory)),
                Layer.provide(GitChangeApplications.layer(directory)),
                Layer.provide(GitChangeJournal.layer(directory)),
                Layer.provide(HarnessRuns.layer),
                Layer.provide(Layer.succeed(ModelService)(models)),
                Layer.provide(
                  Layer.merge(
                    TaskWorktrees.layer(directory),
                    Layer.unwrap(
                      Effect.gen(function* () {
                        const taskResources = yield* TaskResources
                        const synchronization = yield* TaskGitSynchronization
                        return HarnessSessions.layer(
                          runtime.get.pipe(
                            Effect.map((paths) => ({ ...paths, configDirectory: config.directory, agentDirectory, sessionStorageDirectory: join(directory, 'agent-history') })),
                            Effect.mapError(safeError)
                          ),
                          join(directory, 'agent-history'),
                          taskResources.prepare,
                          (task, session) => (session.purpose === 'task' ? Effect.succeed(task.worktree) : synchronization.resolutionDirectory(task.id, session.syncOperationId!))
                        )
                      })
                    )
                  )
                ),
                Layer.provide(ExecutionEventSink.layer),
                Layer.provide(VaultExecutionEvents.layer),
                Layer.provide(Layer.succeed(ExecutionEventLog)(eventLog)),
                Layer.provide(TaskResources.layer(directory)),
                Layer.provide(TaskGitSynchronization.layer(directory)),
                Layer.provide(Layer.succeed(IntegrationService)(integrations)),
                Layer.provide(Layer.succeed(ConfigService)(config)),
                Layer.provide(Layer.succeed(ExecutionNotifications)(notifications)),
                Layer.provide(Layer.mergeAll(HarnessStore.layer, HarnessEventStore.layer, RoutineStore.layer, ExecutionQueue.layer)),
                Layer.provide(vaultDatabaseLayer(directory)),
                  Layer.provideMerge(Layer.succeed(VaultContext)(context)),
                Layer.fresh
              )
            })
          ),
        { idleTimeToLive: Infinity }
      )

      const open = (id: string) =>
        Effect.gen(function* () {
          if (!(yield* config.get).vaults.some((vault) => vault.id === id)) return yield* failure('not-found')
          return yield* Effect.context<TaskService | VaultContext>().pipe(Effect.provide(resources.get(id)))
        }).pipe(Effect.mapError(safeError))
      yield* integrations.watch.pipe(
        Stream.filter((snapshot) =>
          snapshot.some(
            (view) =>
              (view.id === 'lark' || view.id === 'gmail') &&
              view.record?.error === null &&
              view.record.state !== 'checking' &&
              view.record.state !== 'installing' &&
              view.record.resources.some((resource) => (view.id === 'lark' ? resource.type === 'im' || resource.id === 'im' : resource.type === 'email' || resource.id === 'email'))
          )
        ),
        Stream.runForEach(() =>
          Effect.gen(function* () {
            for (const vault of (yield* config.get).vaults) {
              yield* open(vault.id).pipe(
                Effect.flatMap((context) => Context.get(context, TaskService).ensureDefaultRoutine),
                Effect.catch(() => Effect.void)
              )
            }
          })
        ),
        Effect.forkScoped
      )
      return { open }
    })
  )
}
