import { RoutineStore } from './routine-store'
import { RunRoutine, SaveRoutine, type RoutineRecord, type RoutineExecution } from '../../shared/routine'
import { HarnessRuns } from './harness-runs'
import { ModelService } from './model-service'
import { Context, DateTime, Effect, FileSystem, Layer, LayerMap, Schema, Semaphore } from 'effect'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HarnessStoreError, type SessionRecord, type TaskRecord, type RunRecord } from '../../shared/harness'
import {
  CreateTaskInput,
  OpenTaskSessionInput,
  StartConflictResolutionInput,
  StartTaskRunInput,
  type TaskDetail,
  type SessionHistory,
  type RoutineRunResult
} from '../../shared/rpc/task-rpc'
import { Vault } from '../../shared/vault'
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
import { ConfirmRunWikiUnchanged, SaveRunWikiFiles, SaveTaskWikiFiles, SaveWorkspaceFiles, GitConflictContext, type GitChangeApplication } from '../../shared/git-change'
import { WorkspaceChanges } from './workspace-changes'
import { TaskGitSynchronization } from './task-git-synchronization'
import { ReprepareTaskWiki, SynchronizeTaskWiki, type GitSyncOperation } from '../../shared/git-change'

const failure = (reason: HarnessStoreError['reason']) =>
  new HarnessStoreError({
    reason,
    message:
      reason === 'not-found'
        ? 'Vault or Task was not found.'
        : reason === 'invalid-state'
          ? 'Task identity is already associated with different input.'
          : 'Could not access Vault tasks.'
  })
const safeError = (cause: unknown) => (cause instanceof HarnessStoreError ? cause : failure('storage'))

/** Owns a single Vault's shared creation gate and database, independently of requesting windows. */
class VaultTasks extends Context.Service<
  VaultTasks,
  {
    readonly workspace: WorkspaceChanges['Service']
    readonly taskWikiConflictContext: (taskId: string, id: string) => Effect.Effect<typeof GitConflictContext.Type, HarnessStoreError>
    readonly saveWorkspaceFiles: (input: SaveWorkspaceFiles) => Effect.Effect<GitChangeApplication, HarnessStoreError>
    readonly saveTaskWikiFiles: (input: SaveTaskWikiFiles) => Effect.Effect<GitChangeApplication, HarnessStoreError>
    readonly saveRunWikiFiles: (input: SaveRunWikiFiles) => Effect.Effect<GitChangeApplication, HarnessStoreError>
    readonly confirmRunWikiUnchanged: (input: ConfirmRunWikiUnchanged) => Effect.Effect<RunRecord, HarnessStoreError>
    readonly synchronizeTaskWiki: (input: SynchronizeTaskWiki) => Effect.Effect<GitSyncOperation, HarnessStoreError>
    readonly reprepareTaskWiki: (input: ReprepareTaskWiki) => Effect.Effect<GitSyncOperation, HarnessStoreError>
    readonly resolveTaskWikiConflict: (taskId: string, id: string) => Effect.Effect<GitSyncOperation, HarnessStoreError>
    readonly abortTaskWikiConflict: (taskId: string, id: string) => Effect.Effect<GitSyncOperation, HarnessStoreError>
    readonly pendingTaskSynchronizations: (taskId: string) => Effect.Effect<readonly GitSyncOperation[], HarnessStoreError>
    readonly taskSynchronization: (id: string) => Effect.Effect<GitSyncOperation, HarnessStoreError>
    readonly tickRoutines: Effect.Effect<void, HarnessStoreError>
    readonly list: Effect.Effect<readonly TaskRecord[], HarnessStoreError>
    readonly allRoutineExecutions: Effect.Effect<readonly RoutineExecution[], HarnessStoreError>
    readonly routineExecutions: (id: string) => Effect.Effect<readonly RoutineExecution[], HarnessStoreError>
    readonly dispatchRoutine: (id: string) => Effect.Effect<RoutineRunResult | null, HarnessStoreError>
    readonly routines: Effect.Effect<readonly RoutineRecord[], HarnessStoreError>
    readonly saveRoutine: (input: SaveRoutine) => Effect.Effect<RoutineRecord, HarnessStoreError>
    readonly runRoutine: (input: RunRoutine) => Effect.Effect<RoutineRunResult, HarnessStoreError>
    readonly prepareRoutine: (input: RunRoutine) => Effect.Effect<{ execution: RoutineExecution; task: TaskRecord }, HarnessStoreError>
    readonly create: (input: CreateTaskInput) => Effect.Effect<TaskRecord, HarnessStoreError>
    readonly complete: (taskId: string) => Effect.Effect<TaskRecord, HarnessStoreError>
    readonly reopen: (taskId: string) => Effect.Effect<TaskRecord, HarnessStoreError>
    readonly get: (id: string) => Effect.Effect<TaskDetail, HarnessStoreError>
    readonly history: (taskId: string, sessionId: string) => Effect.Effect<SessionHistory, HarnessStoreError>
    readonly startRun: (input: StartTaskRunInput) => Effect.Effect<RunRecord, HarnessStoreError>
    readonly startConflictResolution: (input: Omit<StartConflictResolutionInput, 'vaultId'>) => Effect.Effect<RunRecord, HarnessStoreError>
    readonly inspectRun: (taskId: string, runId: string) => Effect.Effect<RunRecord, HarnessStoreError>
    readonly cancelRun: (taskId: string, runId: string) => Effect.Effect<RunRecord, HarnessStoreError>
    readonly openSession: (input: OpenTaskSessionInput) => Effect.Effect<SessionRecord, HarnessStoreError>
    readonly closeSession: (taskId: string, sessionId: string) => Effect.Effect<void, HarnessStoreError>
  }
>()('folio/services/VaultTasks') {
  static readonly layer = Layer.effect(
    VaultTasks,
    Effect.gen(function* () {
      const workspace = yield* WorkspaceChanges
      const changes = yield* GitChangeApplications
      const synchronization = yield* TaskGitSynchronization
      const routines = yield* RoutineStore
      const events = yield* HarnessEventStore
      const runs = yield* HarnessRuns
      const models = yield* ModelService
      const store = yield* HarnessStore
      const worktrees = yield* TaskWorktrees
      const sessions = yield* HarnessSessions
      const runtime = yield* AgentRuntime
      const integrations = yield* IntegrationService
      const gate = yield* Semaphore.make(1)
      /** The caller retains its UUID for retry; a lost reply must not allocate another Task/worktree. */
      const create = Effect.fn('VaultTasks.create')(function* (input: Omit<CreateTaskInput, 'vaultId'>) {
        const integrationIds = [...new Set(input.integrationIds ?? [])].sort()
        const previous = yield* store
          .task(input.id)
          .pipe(Effect.catchTag('HarnessStoreError', (error) => (error.reason === 'not-found' ? Effect.succeed(null) : Effect.fail(error))))
        if (previous) {
          if (
            previous.goal !== input.goal ||
            previous.configuration.agent !== input.agent ||
            previous.configuration.skillIds.length ||
            JSON.stringify(previous.configuration.integrationIds) !== JSON.stringify(integrationIds)
          )
            return yield* failure('invalid-state')
          // A successful request retry is read-only once the Task has left creation. In
          // particular, completion must not recreate a deliberately released worktree.
          if (previous.state === 'active' && previous.worktreeState !== 'ready') yield* worktrees.ensure(input.id)
        } else {
          if (integrationIds.length) {
            const available = yield* integrations.list.pipe(Effect.mapError(safeError))
            if (integrationIds.some((id) => !available.some((view) => view.id === id && !view.busy && view.record && view.states[view.record.state]?.kind === 'ready')))
              return yield* failure('invalid-state')
          }
          yield* worktrees.create({ id: input.id, goal: input.goal, configuration: { agent: input.agent, skillIds: [], integrationIds } })
        }
        return yield* store.task(input.id)
      }, gate.withPermit)
      /** Checks Task ownership before returning its independent execution histories. */
      const get = Effect.fn('VaultTasks.get')(function* (id: string) {
        return { routine: yield* routines.executionForTask(id), task: yield* store.task(id), sessions: yield* store.sessions(id), runs: yield* store.runs(id) }
      })
      /** Explicit completion reaps live Sessions before the durable worktree release checkpoint. */
      const completeUnlocked = Effect.fn('VaultTasks.completeUnlocked')(function* (taskId: string) {
        const task = yield* store.task(taskId)
        const history = yield* store.runs(taskId)
        if (history.some((run) => run.state === 'preparing' || run.state === 'running'))
          return yield* new HarnessStoreError({ reason: 'task-busy', message: 'Stop the active Run before completing this Task.' })
        if (task.state === 'active' && history.some((run) => run.state === 'succeeded' && run.syncState !== 'completed' && run.syncState !== 'not-required'))
          return yield* failure('invalid-state')
        yield* Effect.forEach(yield* store.sessions(taskId), (session) => sessions.close(taskId, session.id), { concurrency: 'unbounded' })
        return yield* worktrees.complete(taskId)
      })
      const complete = (taskId: string) => completeUnlocked(taskId).pipe(gate.withPermit)
      /** Routine executions are immutable Task associations; reopening them is explicit and manual. */
      const reopen = Effect.fn('VaultTasks.reopen')(function* (taskId: string) {
        if (yield* routines.executionForTask(taskId)) return yield* failure('invalid-state')
        if (yield* sessions.hasLiveTask(taskId)) return yield* failure('task-busy')
        yield* worktrees.reopen(taskId)
        return yield* store.task(taskId)
      }, gate.withPermit)
      /** Routine Tasks end only after an explicit filesystem receipt settles every successful Run. */
      const completeRoutineIfSettled = Effect.fn('VaultTasks.completeRoutineIfSettled')(function* (taskId: string) {
        if (!(yield* routines.executionForTask(taskId))) return
        const task = yield* store.task(taskId)
        // Resume the post-Git/pre-receipt crash window even though the Task is no longer active.
        // New Sessions cannot open after this durable checkpoint, and the original completion
        // path already reaped every Folio-owned Session before writing it.
        if (task.state === 'completed' && task.worktreeState === 'releasing') {
          yield* worktrees.complete(taskId)
          return
        }
        if (task.state !== 'active') return
        const history = yield* store.runs(taskId)
        const succeeded = history.filter((run) => run.state === 'succeeded')
        const latest = history[history.length - 1]
        if (
          !succeeded.length ||
          latest?.state !== 'succeeded' ||
          history.some((run) => run.state === 'preparing' || run.state === 'running') ||
          succeeded.some((run) => run.syncState !== 'completed' && run.syncState !== 'not-required')
        )
          return
        // A user may reopen a settled Task to inspect a retained dirty/error state. Scheduler
        // retries must not repeatedly tear that Session down; explicit completion still may.
        if (yield* sessions.hasLiveTask(taskId)) return
        yield* completeUnlocked(taskId)
      }, gate.withPermit)
      /** Receipt RPCs stay truthful when the independent worktree cleanup needs a later retry. */
      const completeRoutineAfterReceipt = (taskId: string) =>
        completeRoutineIfSettled(taskId).pipe(Effect.catch(() => Effect.logWarning('Settled Routine Task could not be released; its worktree is retained for inspection.')))
      /** Allocates identity before native startup; model choice is never invented by this storage/lifecycle endpoint. */
      const prepareSession = Effect.fn('VaultTasks.prepareSession')(function* (input: Omit<OpenTaskSessionInput, 'vaultId'>) {
        const task = yield* store.task(input.taskId)
        if (task.configuration.agent !== input.agent) return yield* failure('invalid-state')
        const previous = (yield* store.sessions(input.taskId)).find((session) => session.id === input.sessionId)
        if (previous) {
          if (previous.agent !== input.agent || previous.purpose !== 'task' || previous.syncOperationId !== null) return yield* failure('invalid-state')
          const profile = previous.modelProfile
          if (previous.agent === 'pi' && !profile) return yield* failure('invalid-state')
          if (
            input.model &&
            (!profile || input.model.providerId !== profile.provider.providerId || input.model.modelId !== profile.modelId || input.model.thinkingLevel !== profile.thinkingLevel)
          )
            return yield* failure('invalid-state')
        } else {
          const paths = yield* runtime.get.pipe(Effect.mapError(safeError))
          if ((input.agent === 'pi') !== (input.model !== undefined)) return yield* failure('invalid-state')
          const modelProfile = input.model
            ? yield* models.resolveSessionModel(input.model).pipe(Effect.mapError((error) => new HarnessStoreError({ reason: 'invalid-state', message: error.message })))
            : null
          yield* store.createSession({
            id: input.sessionId,
            taskId: input.taskId,
            agent: input.agent,
            adapterVersion: paths.agentVersion,
            purpose: 'task',
            syncOperationId: null,
            modelProfile
          })
        }
      })
      const openSession = Effect.fn('VaultTasks.openSession')(function* (input: OpenTaskSessionInput) {
        yield* prepareSession(input)
        yield* sessions.open(input.taskId, input.sessionId)
        const saved = (yield* store.sessions(input.taskId)).find((session) => session.id === input.sessionId)
        if (!saved) return yield* failure('not-found')
        return saved
      }, gate.withPermit)
      /** Checks Session ownership before returning any saved conversation content. */
      const history = Effect.fn('VaultTasks.history')(function* (taskId: string, sessionId: string) {
        yield* store.task(taskId)
        if (!(yield* store.sessions(taskId)).some((session) => session.id === sessionId)) return yield* failure('not-found')
        const messages = yield* events.messages(sessionId)
        return { messages }
      })
      /** Creates one operation-bound Session and lets the Agent edit only the isolated coordinator. */
      const startConflictResolution = Effect.fn('VaultTasks.startConflictResolution')(function* (input: Omit<StartConflictResolutionInput, 'vaultId'>) {
        const task = yield* store.task(input.taskId)
        const operation = yield* synchronization.get(input.operationId)
        if (operation.taskId !== task.id) return yield* failure('not-found')
        const savedSessions = yield* store.sessions(task.id)
        const source = savedSessions.find((session) => session.id === input.sourceSessionId)
        if (!source || source.purpose !== 'task' || source.agent !== task.configuration.agent) return yield* failure('invalid-state')
        const previousRun = (yield* store.runs(task.id)).find((run) => run.id === input.runId)
        if (previousRun) {
          if (previousRun.sessionId !== input.sessionId || previousRun.purpose !== 'conflict-resolution' || previousRun.resumesRunId !== null)
            return yield* failure('invalid-state')
          const target = savedSessions.find((session) => session.id === input.sessionId)
          if (!target || target.purpose !== 'conflict-resolution' || target.syncOperationId !== operation.id || target.agent !== source.agent)
            return yield* failure('invalid-state')
          // A lost post-processing reply is retried without redispatching the Prompt.
          if (previousRun.state === 'succeeded' && operation.state !== 'aligned') {
            yield* synchronization.acceptAgentResolution(task.id, operation.id, previousRun.id)
          }
          return previousRun
        }
        if (operation.state !== 'conflict') return yield* failure('invalid-state')
        const context = yield* synchronization.resolutionContext(task.id, operation.id)
        const target = savedSessions.find((session) => session.id === input.sessionId)
        if (target) {
          if (
            target.purpose !== 'conflict-resolution' ||
            target.syncOperationId !== operation.id ||
            target.agent !== source.agent ||
            JSON.stringify(target.modelProfile ?? null) !== JSON.stringify(source.modelProfile ?? null)
          )
            return yield* failure('invalid-state')
        } else {
          const paths = yield* runtime.get.pipe(Effect.mapError(safeError))
          yield* store.createSession({
            id: input.sessionId,
            taskId: task.id,
            agent: source.agent,
            adapterVersion: paths.agentVersion,
            purpose: 'conflict-resolution',
            syncOperationId: operation.id,
            modelProfile: source.modelProfile ?? null
          })
        }
        const prompt = [
          'Resolve the current Git conflict for Folio by editing the working files in this directory.',
          '',
          `Task goal: ${task.goal}`,
          `Common base commit: ${context.commonBase}`,
          `Conflicting files:\n${context.files.map((path) => `- ${path}`).join('\n')}`,
          '',
          'Canonical/main-side diff:',
          '```diff',
          context.canonicalDiff,
          '```',
          '',
          'Task-side diff:',
          '```diff',
          context.taskDiff,
          '```',
          '',
          'Edit only ordinary files under wiki/. Do not run git, change the index, commit, publish, or modify another checkout.',
          'Finish only after every conflict is resolved in the working files. Folio will validate, stage, publish, and align the result.'
        ].join('\n')
        const intent = { id: input.runId, taskId: task.id, sessionId: input.sessionId, prompt, purpose: 'conflict-resolution' as const, resumesRunId: null }
        return yield* runs.start(intent, (terminal) =>
          terminal.state === 'succeeded'
            ? synchronization.acceptAgentResolution(task.id, operation.id, terminal.id).pipe(
                Effect.tap((settled) => (settled.state === 'aligned' ? completeRoutineAfterReceipt(task.id) : Effect.void)),
                Effect.asVoid
              )
            : Effect.void
        )
      }, gate.withPermit)
      /** Save definitions offline; capability health is checked when a Task actually prepares execution. */
      const saveRoutine = Effect.fn('VaultTasks.saveRoutine')(function* (input: SaveRoutine) {
        // Independent Skill selection is not mounted yet; refusing it avoids silently dropping intent.
        if (input.skillIds.length) return yield* failure('invalid-state')
        return yield* routines.save(input)
      })
      /** Creates or coalesces one current execution, then optionally starts its Task Run. */
      const prepareRoutine = Effect.fn('VaultTasks.prepareRoutine')(function* (input: RunRoutine) {
        const execution = yield* routines.schedule(input.routineId)
        const routine = yield* routines.get(input.routineId)
        // Derive the reservation's Task identity from the execution so concurrent
        // scheduler ticks converge on one Task instead of orphaning duplicates.
        const taskId = execution.taskId ?? execution.id
        const task = yield* create({ id: taskId, goal: routine.prompt, agent: routine.agent, integrationIds: routine.integrationIds })
        const attached = yield* routines.attachTask(execution.id, task.id)
        return { execution: attached, task }
      })
      const runRoutine = Effect.fn('VaultTasks.runRoutine')(function* (input: RunRoutine) {
        const { execution, task } = yield* prepareRoutine(input)
        const routine = yield* routines.get(input.routineId)
        const sessionId = randomUUID()
        const runId = randomUUID()
        yield* prepareSession({ taskId: task.id, sessionId, agent: routine.agent, ...(routine.model ? { model: routine.model } : {}) }).pipe(gate.withPermit)
        yield* routines.setStatus(task.id, 'preparing')
        const run = yield* runs.start({ id: runId, taskId: task.id, sessionId, prompt: routine.prompt, purpose: 'execution', resumesRunId: null }, (terminal) =>
          routines.setStatus(task.id, terminal.state).pipe(Effect.andThen(terminal.state === 'succeeded' ? completeRoutineAfterReceipt(task.id) : Effect.void))
        )
        return { execution, task, run }
      })
      const dispatchRoutine = Effect.fn('VaultTasks.dispatchRoutine')(function* (id: string) {
        return yield* runRoutine({ routineId: id })
      })
      // Collect a bounded page first. No batch is dispatched while missed dates remain uncollected.
      const tickRoutines = Effect.gen(function* () {
        // A crash may land after the final Run receipt but before worktree release. Reconcile
        // durable Routine state before admitting another batch; one dirty Task cannot stop peers.
        for (const task of yield* store.tasks) {
          yield* completeRoutineIfSettled(task.id).pipe(
            Effect.catch(() => Effect.logWarning('Settled Routine Task could not be released; its worktree is retained for inspection.'))
          )
        }
        const current = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis))
        for (const routine of yield* routines.list) {
          if (!routine.enabled || (routine.nextTriggerAt !== null && routine.nextTriggerAt > current)) continue
          yield* dispatchRoutine(routine.id).pipe(Effect.catch(() => Effect.logWarning('Routine dispatch could not complete; its execution remains retryable.')))
        }
      }).pipe(Effect.mapError(safeError))
      /** Returns only this Task's actionable operation after proving the Task belongs to the Vault. */
      const pendingTaskSynchronizations = Effect.fn('VaultTasks.pendingTaskSynchronizations')(function* (taskId: string) {
        yield* store.task(taskId)
        return (yield* synchronization.pending).filter((operation) => operation.taskId === taskId)
      })
      /** Conflict actions require both identities so a caller cannot operate on another Task's receipt. */
      const conflictAction = Effect.fn('VaultTasks.conflictAction')(function* (taskId: string, id: string, action: 'resolve' | 'abort') {
        yield* store.task(taskId)
        const operation = yield* synchronization.get(id)
        if (operation.taskId !== taskId) return yield* failure('not-found')
        const settled = yield* action === 'resolve' ? synchronization.resolve(id) : synchronization.abort(id)
        if (settled.state === 'aligned') yield* completeRoutineAfterReceipt(taskId)
        return settled
      })
      return VaultTasks.of({
        tickRoutines,
        dispatchRoutine,
        runRoutine,
        prepareRoutine,
        routineExecutions: routines.executions,
        allRoutineExecutions: routines.allExecutions,
        routines: routines.list,
        saveRoutine,
        workspace,
        taskWikiConflictContext: (taskId, id) =>
          Effect.gen(function* () {
            yield* store.task(taskId)
            const context = yield* synchronization.resolutionContext(taskId, id)
            return { files: context.files, commonBase: context.commonBase, canonicalDiff: context.canonicalDiff, taskDiff: context.taskDiff }
          }),
        saveWorkspaceFiles: (input) => changes.save({ ...input, taskId: null }),
        saveTaskWikiFiles: changes.save,
        saveRunWikiFiles: changes.saveRunWiki,
        confirmRunWikiUnchanged: (input) => changes.confirmRunWikiUnchanged(input).pipe(Effect.tap(() => completeRoutineAfterReceipt(input.taskId))),
        synchronizeTaskWiki: (input) =>
          synchronization.synchronize(input).pipe(Effect.tap((operation) => (operation.state === 'aligned' ? completeRoutineAfterReceipt(input.taskId) : Effect.void))),
        reprepareTaskWiki: (input) =>
          synchronization.reprepare(input).pipe(Effect.tap((operation) => (operation.state === 'aligned' ? completeRoutineAfterReceipt(input.taskId) : Effect.void))),
        resolveTaskWikiConflict: (taskId, id) => conflictAction(taskId, id, 'resolve'),
        abortTaskWikiConflict: (taskId, id) => conflictAction(taskId, id, 'abort'),
        pendingTaskSynchronizations,
        taskSynchronization: synchronization.get,
        history,
        list: store.tasks,
        create: (input) => create(input),
        complete,
        reopen,
        get,
        openSession,
        closeSession: sessions.close,
        startRun: runs.start,
        startConflictResolution,
        inspectRun: runs.inspect,
        cancelRun: runs.cancel
      })
    })
  )
}

/** Resolves registered Vault IDs into application-owned resources; never accepts renderer filesystem paths. */
export class TaskService extends Context.Service<
  TaskService,
  {
    readonly workspaceChanges: (vaultId: string) => WorkspaceChanges['Service']['inspect']
    readonly workspaceDiff: (vaultId: string, input: Parameters<WorkspaceChanges['Service']['diff']>[0]) => ReturnType<WorkspaceChanges['Service']['diff']>
    readonly taskWikiChanges: (vaultId: string, taskId: string) => ReturnType<WorkspaceChanges['Service']['inspectTaskWiki']>
    readonly taskWikiDiff: (
      vaultId: string,
      taskId: string,
      input: Parameters<WorkspaceChanges['Service']['diffTaskWiki']>[1]
    ) => ReturnType<WorkspaceChanges['Service']['diffTaskWiki']>
    readonly taskWikiConflictContext: (vaultId: string, taskId: string, id: string) => Effect.Effect<typeof GitConflictContext.Type, HarnessStoreError>
    readonly saveWorkspaceFiles: (vaultId: string, input: SaveWorkspaceFiles) => Effect.Effect<GitChangeApplication, HarnessStoreError>
    readonly saveTaskWikiFiles: (vaultId: string, input: SaveTaskWikiFiles) => Effect.Effect<GitChangeApplication, HarnessStoreError>
    readonly saveRunWikiFiles: (vaultId: string, input: SaveRunWikiFiles) => Effect.Effect<GitChangeApplication, HarnessStoreError>
    readonly confirmRunWikiUnchanged: (vaultId: string, input: ConfirmRunWikiUnchanged) => Effect.Effect<RunRecord, HarnessStoreError>
    readonly synchronizeTaskWiki: (vaultId: string, input: SynchronizeTaskWiki) => Effect.Effect<GitSyncOperation, HarnessStoreError>
    readonly reprepareTaskWiki: (vaultId: string, input: ReprepareTaskWiki) => Effect.Effect<GitSyncOperation, HarnessStoreError>
    readonly resolveTaskWikiConflict: (vaultId: string, taskId: string, id: string) => Effect.Effect<GitSyncOperation, HarnessStoreError>
    readonly abortTaskWikiConflict: (vaultId: string, taskId: string, id: string) => Effect.Effect<GitSyncOperation, HarnessStoreError>
    readonly pendingTaskSynchronizations: (vaultId: string, taskId: string) => Effect.Effect<readonly GitSyncOperation[], HarnessStoreError>
    readonly taskSynchronization: (vaultId: string, id: string) => Effect.Effect<GitSyncOperation, HarnessStoreError>
    readonly list: (vaultId: string) => Effect.Effect<readonly TaskRecord[], HarnessStoreError>
    readonly routineExecutions: (vaultId: string, routineId: string) => Effect.Effect<readonly RoutineExecution[], HarnessStoreError>
    readonly allRoutineExecutions: (vaultId: string) => Effect.Effect<readonly RoutineExecution[], HarnessStoreError>
    readonly tickRoutines: (vaultId: string) => Effect.Effect<void, HarnessStoreError>
    readonly dispatchRoutine: (vaultId: string, routineId: string) => Effect.Effect<RoutineRunResult | null, HarnessStoreError>
    readonly listRoutines: (vaultId: string) => Effect.Effect<readonly RoutineRecord[], HarnessStoreError>
    readonly saveRoutine: (vaultId: string, input: SaveRoutine) => Effect.Effect<RoutineRecord, HarnessStoreError>
    readonly runRoutine: (vaultId: string, input: RunRoutine) => Effect.Effect<RoutineRunResult, HarnessStoreError>
    readonly prepareRoutine: (vaultId: string, input: RunRoutine) => Effect.Effect<{ execution: RoutineExecution; task: TaskRecord }, HarnessStoreError>
    readonly create: (input: CreateTaskInput) => Effect.Effect<TaskRecord, HarnessStoreError>
    readonly complete: (vaultId: string, taskId: string) => Effect.Effect<TaskRecord, HarnessStoreError>
    readonly reopen: (vaultId: string, taskId: string) => Effect.Effect<TaskRecord, HarnessStoreError>
    readonly get: (vaultId: string, id: string) => Effect.Effect<TaskDetail, HarnessStoreError>
    readonly history: (vaultId: string, taskId: string, sessionId: string) => Effect.Effect<SessionHistory, HarnessStoreError>
    readonly startRun: (input: StartTaskRunInput) => Effect.Effect<RunRecord, HarnessStoreError>
    readonly startConflictResolution: (input: StartConflictResolutionInput) => Effect.Effect<RunRecord, HarnessStoreError>
    readonly inspectRun: (vaultId: string, taskId: string, runId: string) => Effect.Effect<RunRecord, HarnessStoreError>
    readonly cancelRun: (vaultId: string, taskId: string, runId: string) => Effect.Effect<RunRecord, HarnessStoreError>
    readonly openSession: (input: OpenTaskSessionInput) => Effect.Effect<SessionRecord, HarnessStoreError>
    readonly closeSession: (vaultId: string, taskId: string, sessionId: string) => Effect.Effect<void, HarnessStoreError>
  }
>()('folio/services/TaskService') {
  static readonly layer = Layer.effect(
    TaskService,
    Effect.gen(function* () {
      const config = yield* ConfigService
      const fs = yield* FileSystem.FileSystem
      const runtime = yield* AgentRuntime
      const models = yield* ModelService
      const integrations = yield* IntegrationService
      const agentDirectory = models.directory
      const resources = yield* LayerMap.make(
        (id: string) =>
          Layer.unwrap(
            Effect.gen(function* () {
              const directory = join(config.directory, 'vaults', id)
              // Registration owns initialization. A read must not silently create a missing or redirected Vault.
              if ((yield* fs.realPath(directory)) !== directory || !(yield* fs.exists(join(directory, 'data.db')))) return yield* failure('not-found')
              return VaultTasks.layer.pipe(
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
                Layer.provide(TaskResources.layer(directory)),
                Layer.provide(TaskGitSynchronization.layer(directory)),
                Layer.provide(Layer.succeed(IntegrationService)(integrations)),
                Layer.provide(Layer.succeed(ConfigService)(config)),
                Layer.provide(Layer.mergeAll(HarnessStore.layer, HarnessEventStore.layer, RoutineStore.layer)),
                Layer.provide(vaultDatabaseLayer(directory)),
                Layer.fresh
              )
            })
          ),
        { idleTimeToLive: Infinity }
      )
      /** Revalidates the global index on every call; cached resources cannot make an unknown ID valid. */
      const inVault = Effect.fn('TaskService.inVault')(function* <A>(id: string, action: Effect.Effect<A, HarnessStoreError, VaultTasks>) {
        yield* Schema.decodeUnknownEffect(Vault.fields.id)(id)
        if (!(yield* config.get).vaults.some((vault) => vault.id === id)) return yield* failure('not-found')
        return yield* action.pipe(Effect.provide(resources.get(id)))
      }, Effect.mapError(safeError))
      return TaskService.of({
        workspaceChanges: (id) =>
          inVault(
            id,
            Effect.flatMap(VaultTasks, (service) => service.workspace.inspect)
          ),
        workspaceDiff: (id, input) =>
          inVault(
            id,
            Effect.flatMap(VaultTasks, (service) => service.workspace.diff(input))
          ),
        taskWikiChanges: (id, taskId) =>
          inVault(
            id,
            Effect.flatMap(VaultTasks, (service) => service.workspace.inspectTaskWiki(taskId))
          ),
        taskWikiDiff: (id, taskId, input) =>
          inVault(
            id,
            Effect.flatMap(VaultTasks, (service) => service.workspace.diffTaskWiki(taskId, input))
          ),
        taskWikiConflictContext: (vaultId, taskId, id) =>
          inVault(
            vaultId,
            Effect.flatMap(VaultTasks, (service) => service.taskWikiConflictContext(taskId, id))
          ),
        saveWorkspaceFiles: (id, input) =>
          inVault(
            id,
            Effect.gen(function* () {
              const value = yield* Schema.decodeUnknownEffect(SaveWorkspaceFiles)(input, { onExcessProperty: 'error' })
              return yield* (yield* VaultTasks).saveWorkspaceFiles(value)
            }).pipe(Effect.mapError(safeError))
          ),
        saveTaskWikiFiles: (id, input) =>
          Schema.decodeUnknownEffect(SaveTaskWikiFiles)(input, { onExcessProperty: 'error' }).pipe(
            Effect.flatMap((value) =>
              inVault(
                id,
                Effect.flatMap(VaultTasks, (service) => service.saveTaskWikiFiles(value))
              )
            ),
            Effect.mapError(safeError)
          ),
        saveRunWikiFiles: (id, input) =>
          Schema.decodeUnknownEffect(SaveRunWikiFiles)(input, { onExcessProperty: 'error' }).pipe(
            Effect.flatMap((value) =>
              inVault(
                id,
                Effect.flatMap(VaultTasks, (service) => service.saveRunWikiFiles(value))
              )
            ),
            Effect.mapError(safeError)
          ),
        confirmRunWikiUnchanged: (id, input) =>
          Schema.decodeUnknownEffect(ConfirmRunWikiUnchanged)(input, { onExcessProperty: 'error' }).pipe(
            Effect.flatMap((value) =>
              inVault(
                id,
                Effect.flatMap(VaultTasks, (service) => service.confirmRunWikiUnchanged(value))
              )
            ),
            Effect.mapError(safeError)
          ),
        synchronizeTaskWiki: (id, input) =>
          Schema.decodeUnknownEffect(SynchronizeTaskWiki)(input, { onExcessProperty: 'error' }).pipe(
            Effect.flatMap((value) =>
              inVault(
                id,
                Effect.flatMap(VaultTasks, (service) => service.synchronizeTaskWiki(value))
              )
            ),
            Effect.mapError(safeError)
          ),
        reprepareTaskWiki: (id, input) =>
          Schema.decodeUnknownEffect(ReprepareTaskWiki)(input, { onExcessProperty: 'error' }).pipe(
            Effect.flatMap((value) =>
              inVault(
                id,
                Effect.flatMap(VaultTasks, (service) => service.reprepareTaskWiki(value))
              )
            ),
            Effect.mapError(safeError)
          ),
        resolveTaskWikiConflict: (vaultId, taskId, id) =>
          inVault(
            vaultId,
            Effect.flatMap(VaultTasks, (service) => service.resolveTaskWikiConflict(taskId, id))
          ),
        abortTaskWikiConflict: (vaultId, taskId, id) =>
          inVault(
            vaultId,
            Effect.flatMap(VaultTasks, (service) => service.abortTaskWikiConflict(taskId, id))
          ),
        pendingTaskSynchronizations: (id, taskId) =>
          inVault(
            id,
            Effect.flatMap(VaultTasks, (service) => service.pendingTaskSynchronizations(taskId))
          ),
        taskSynchronization: (vaultId, id) =>
          inVault(
            vaultId,
            Effect.flatMap(VaultTasks, (service) => service.taskSynchronization(id))
          ),
        tickRoutines: (id) =>
          inVault(
            id,
            Effect.flatMap(VaultTasks, (service) => service.tickRoutines)
          ),
        dispatchRoutine: (id, routineId) =>
          inVault(
            id,
            Effect.flatMap(VaultTasks, (service) => service.dispatchRoutine(routineId))
          ),
        routineExecutions: (id, routineId) =>
          inVault(
            id,
            Effect.flatMap(VaultTasks, (service) => service.routineExecutions(routineId))
          ),
        allRoutineExecutions: (id) =>
          inVault(
            id,
            Effect.flatMap(VaultTasks, (service) => service.allRoutineExecutions)
          ),
        listRoutines: (id) =>
          inVault(
            id,
            Effect.flatMap(VaultTasks, (service) => service.routines)
          ),
        saveRoutine: (id, input) =>
          Schema.decodeUnknownEffect(SaveRoutine)(input, { onExcessProperty: 'error' }).pipe(
            Effect.flatMap((value) =>
              inVault(
                id,
                Effect.flatMap(VaultTasks, (service) => service.saveRoutine(value))
              )
            ),
            Effect.mapError(safeError)
          ),
        runRoutine: (id, input) =>
          Schema.decodeUnknownEffect(RunRoutine)(input, { onExcessProperty: 'error' }).pipe(
            Effect.flatMap((value) =>
              inVault(
                id,
                Effect.flatMap(VaultTasks, (service) => service.runRoutine(value))
              )
            ),
            Effect.mapError(safeError)
          ),
        prepareRoutine: (id, input) =>
          Schema.decodeUnknownEffect(RunRoutine)(input, { onExcessProperty: 'error' }).pipe(
            Effect.flatMap((value) =>
              inVault(
                id,
                Effect.flatMap(VaultTasks, (service) => service.prepareRoutine(value))
              )
            ),
            Effect.mapError(safeError)
          ),
        list: (id) =>
          inVault(
            id,
            Effect.flatMap(VaultTasks, (service) => service.list)
          ),
        get: (vaultId, id) =>
          inVault(
            vaultId,
            Effect.flatMap(VaultTasks, (service) => service.get(id))
          ),
        complete: (vaultId, taskId) =>
          inVault(
            vaultId,
            Effect.flatMap(VaultTasks, (service) => service.complete(taskId))
          ),
        reopen: (vaultId, taskId) =>
          inVault(
            vaultId,
            Effect.flatMap(VaultTasks, (service) => service.reopen(taskId))
          ),
        closeSession: (vaultId, taskId, sessionId) =>
          inVault(
            vaultId,
            Effect.flatMap(VaultTasks, (service) => service.closeSession(taskId, sessionId))
          ),
        history: (vaultId, taskId, sessionId) =>
          inVault(
            vaultId,
            Effect.flatMap(VaultTasks, (service) => service.history(taskId, sessionId))
          ),
        startRun: (input) =>
          Schema.decodeUnknownEffect(StartTaskRunInput)(input, { onExcessProperty: 'error' }).pipe(
            Effect.flatMap((value) =>
              inVault(
                value.vaultId,
                Effect.flatMap(VaultTasks, (service) => service.startRun(value))
              )
            ),
            Effect.mapError(safeError)
          ),
        startConflictResolution: (input) =>
          Schema.decodeUnknownEffect(StartConflictResolutionInput)(input, { onExcessProperty: 'error' }).pipe(
            Effect.flatMap((value) =>
              inVault(
                value.vaultId,
                Effect.flatMap(VaultTasks, (service) => service.startConflictResolution(value))
              )
            ),
            Effect.mapError(safeError)
          ),
        inspectRun: (vaultId, taskId, runId) =>
          inVault(
            vaultId,
            Effect.flatMap(VaultTasks, (service) => service.inspectRun(taskId, runId))
          ),
        cancelRun: (vaultId, taskId, runId) =>
          inVault(
            vaultId,
            Effect.flatMap(VaultTasks, (service) => service.cancelRun(taskId, runId))
          ),
        openSession: (input) =>
          Schema.decodeUnknownEffect(OpenTaskSessionInput)(input, { onExcessProperty: 'error' }).pipe(
            Effect.flatMap((value) =>
              inVault(
                value.vaultId,
                Effect.flatMap(VaultTasks, (service) => service.openSession(value))
              )
            ),
            Effect.mapError(safeError)
          ),
        create: (input) =>
          Schema.decodeUnknownEffect(CreateTaskInput)(input, { onExcessProperty: 'error' }).pipe(
            Effect.flatMap((value) =>
              inVault(
                value.vaultId,
                Effect.flatMap(VaultTasks, (service) => service.create(value))
              )
            ),
            Effect.mapError(safeError)
          )
      })
    })
  )
}
