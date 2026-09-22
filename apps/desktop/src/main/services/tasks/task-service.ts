import { AgentWorkerPool } from '../agent/agent-worker-pool'
import { VaultContext } from '../vault/vault-context'
import { ExecutionEventSink } from '../execution/execution-event-sink'
import { recoverExecutions } from '../execution/execution-recovery'
import agentPackage from '../../../../../../packages/agent/package.json'
import { RunFiles } from '../execution/run-files'
import { ExecutionQueue } from '../execution/execution-queue'
import { ExecutionNotifications } from '../execution/execution-scheduler'
import { SqlClient } from 'effect/unstable/sql'
import type { RunRecord } from '../../../shared/execution'
import { TaskService } from '../../../shared/task-service'
import { RoutineStore } from '../routines/routine-store'
import { routineDateAt, routineTimestampAt, type RunRoutine, type SaveRoutine } from '../../../shared/routine'
import { HarnessRuns } from '../harness/harness-runs'
import { ModelService } from '../models/model-service'
import { Cause, DateTime, Effect, Exit, Fiber, Layer, Schema, Scope, Semaphore } from 'effect'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import { HarnessStoreError, TaskSummary, type IngestionReceipt, type TaskRecord } from '../../../shared/harness'
import type { CreateTaskInput, OpenTaskSessionInput, StartConflictResolutionInput, TaskFeedCursor } from '../../../shared/rpc/task-rpc'
import { HarnessStore } from '../harness/harness-store'
import { IntegrationService } from '../integrations/integration-service'
import { TaskWorktrees } from './task-worktrees'
import { HarnessSessions } from '../harness/harness-sessions'
import { HarnessEventStore } from '../harness/harness-event-store'
import { GitChangeApplications } from '../git/git-change-applications'
import { WorkspaceChanges } from '../git/workspace-changes'
import { TaskGitSynchronization } from './task-git-synchronization'
import { makeVaultGit } from '../git/vault-git'
import { ConfigService } from '../config/config-service'

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
const now = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis))
export { TaskService } from '../../../shared/task-service'

/** Owns a single Vault's shared creation gate and database, independently of requesting windows. */
export const TaskServiceLive = Layer.effect(
  TaskService,
  Effect.gen(function* () {
    const workers = yield* AgentWorkerPool
    const vault = yield* VaultContext
    const config = yield* ConfigService
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
    const queue = yield* ExecutionQueue
    const runFiles = yield* RunFiles
    const sink = yield* ExecutionEventSink
    const notifications = yield* ExecutionNotifications
    const sql = yield* SqlClient.SqlClient
    const integrations = yield* IntegrationService
    const git = yield* makeVaultGit
    const scope = yield* Scope.Scope
    const gate = yield* Semaphore.make(1)
    const ingestionReceiptGate = yield* Semaphore.make(1)
    const ownedExecutions = new Set<string>()
    const ingestionFibers = new Map<string, Fiber.Fiber<void, never>>()
    /** The caller retains its UUID for retry; a lost reply must not allocate another Task/worktree. */
    const create = Effect.fn('TaskService.create')(function* (input: CreateTaskInput) {
      const integrationIds = [...new Set(input.integrationIds ?? [])].sort()
      const resourceIds = [...new Set(input.resourceIds ?? [])].sort()
      if (
        resourceIds.some((reference) => {
          const separator = reference.indexOf('/')
          return separator <= 0 || !integrationIds.includes(reference.slice(0, separator))
        })
      )
        return yield* failure('invalid-state')
      const previous = yield* store.task(input.id).pipe(Effect.catchTag('HarnessStoreError', (error) => (error.reason === 'not-found' ? Effect.succeed(null) : Effect.fail(error))))
      if (previous) {
        if (
          previous.type !== 'agent' ||
          previous.configuration.goal !== input.goal ||
          previous.configuration.agent !== input.agent ||
          previous.configuration.skillIds.length ||
          JSON.stringify(previous.configuration.integrationIds) !== JSON.stringify(integrationIds) ||
          JSON.stringify(previous.configuration.resourceIds) !== JSON.stringify(resourceIds)
        )
          return yield* failure('invalid-state')
        // Retrying admission must never create resources or revive a completed Task.
      } else {
        // Capability health is checked by TaskResources inside the Worker, after admission.
        yield* worktrees.reserve({ id: input.id, type: 'agent', receipt: null,
          configuration: { goal: input.goal, agent: input.agent, model: null, skillIds: [], integrationIds, resourceIds } })
      }
      return yield* store.task(input.id)
    })
    /** Checks Task ownership before returning its independent execution histories. */
    const get = Effect.fn('TaskService.get')(function* (id: string) {
      return { routine: yield* routines.executionForTask(id), task: yield* store.task(id), sessions: yield* store.sessions(id), runs: yield* store.runs(id) }
    })
    /** Bounded, stable creation-time pagination; the current Run is only live status, not the durable summary. */
    const feed = Effect.fn('TaskService.feed')(function* (cursor: TaskFeedCursor | null) {
      const rows = yield* sql<{ id: string; createdAt: number; runId: string | null; routineName: string | null;
        windowStart: number | null; windowEnd: number | null; timeZone: string | null }>`SELECT t.id, t.created_at AS createdAt,
          (SELECT id FROM runs WHERE task_id=t.id AND purpose<>'conflict-resolution' ORDER BY sequence DESC LIMIT 1) AS runId,
          routine.name AS routineName, schedule.window_start AS windowStart, schedule.window_end AS windowEnd,
          schedule.time_zone AS timeZone
          FROM tasks t LEFT JOIN routines routine ON routine.id=t.routine_id
          LEFT JOIN routine_schedules schedule ON schedule.task_id=t.id
          WHERE (${cursor?.createdAt ?? null} IS NULL OR t.created_at<${cursor?.createdAt ?? null}
            OR (t.created_at=${cursor?.createdAt ?? null} AND t.id<${cursor?.id ?? null}))
          ORDER BY t.created_at DESC, t.id DESC LIMIT 31`
      const page = rows.slice(0, 30)
      const entries = yield* Effect.forEach(page, row => Effect.gen(function* () {
        const task = yield* store.task(row.id)
        const latestRun = row.runId ? yield* queue.get(row.runId) : null
        return { task, latestRun, routineName: row.routineName,
          schedule: row.windowStart === null || row.windowEnd === null || row.timeZone === null ? null
            : { windowStart: row.windowStart, windowEnd: row.windowEnd, timeZone: row.timeZone } }
      }))
      const last = page.at(-1)
      return { entries, nextCursor: rows.length > 30 && last ? { createdAt: last.createdAt, id: last.id } : null }
    }, Effect.mapError(safeError))
    /** A no-change receipt only updates the summary of the Run it confirmed. */
    const markWikiUnchanged = (taskId: string, runId: string) =>
      sql`UPDATE tasks SET summary=json_set(summary, '$.publication.state', 'not-required')
        WHERE id=${taskId} AND json_extract(summary, '$.runId')=${runId}`.pipe(Effect.mapError(safeError))
    /** Explicit completion reaps live Sessions before the durable worktree release checkpoint. */
    const completeUnlocked = Effect.fn('TaskService.completeUnlocked')(function* (taskId: string) {
      const task = yield* store.task(taskId)
      const history = yield* store.runs(taskId)
      if (history.some(run => run.endedAt === null))
        return yield* new HarnessStoreError({ reason: 'task-busy', message: 'Stop the active Run before completing this Task.' })
      if (task.state === 'active' && history.some((run) => run.state === 'succeeded' && run.syncState !== 'completed' && run.syncState !== 'not-required'))
        return yield* failure('invalid-state')
      yield* Effect.forEach(yield* store.sessions(taskId), (session) => sessions.close(taskId, session.id), { concurrency: 'unbounded' })
      return yield* worktrees.complete(taskId)
    })
    const complete = (taskId: string) => completeUnlocked(taskId).pipe(gate.withPermit)
    /** Routine executions are immutable Task associations; reopening them is explicit and manual. */
    const reopen = Effect.fn('TaskService.reopen')(function* (taskId: string) {
      if (yield* routines.executionForTask(taskId)) return yield* failure('invalid-state')
      if (yield* sessions.hasLiveTask(taskId)) return yield* failure('task-busy')
      yield* worktrees.reopen(taskId)
      return yield* store.task(taskId)
    }, gate.withPermit, Effect.mapError(safeError))
    /** Routine Tasks end only after an explicit filesystem receipt settles every successful Run. */
    const completeRoutineIfSettled = Effect.fn('TaskService.completeRoutineIfSettled')(function* (taskId: string) {
      if (!(yield* routines.executionForTask(taskId))) return
      const task = yield* store.task(taskId)
      if (task.type !== 'agent') return
      // Resume the post-Git/pre-receipt crash window even though the Task is no longer active.
      // New Sessions cannot open after this durable checkpoint, and the original completion
      // path already reaped every Folio-owned Session before writing it.
      if (task.state === 'completed' && task.worktreeState === 'releasing') {
        yield* worktrees.complete(taskId)
        return
      }
      if (task.state !== 'active') return
      let history = yield* store.runs(taskId)
      if (history.some(run => run.endedAt === null)) return
      // Routine prompts are source-ingestion prompts. Automatically close the
      // wiki receipt when no wiki files changed; an actual wiki edit still
      // follows the existing explicit save/synchronization path.
      for (const run of history.filter((candidate) => candidate.state === 'succeeded' && candidate.syncState === 'pending')) {
        yield* changes.confirmRunWikiUnchanged({ taskId, runId: run.id, expectedHead: run.baselineCommit! }).pipe(
          Effect.tap(() => markWikiUnchanged(taskId, run.id)),
          Effect.catch(() => Effect.void))
      }
      history = yield* store.runs(taskId)
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
    }, gate.withPermit, Effect.mapError(safeError))
    /** Receipt RPCs stay truthful when the independent worktree cleanup needs a later retry. */
    const completeRoutineAfterReceipt = (taskId: string) =>
      completeRoutineIfSettled(taskId).pipe(Effect.catch(error => Effect.logWarning(
        'Settled Routine Task could not be released; its worktree is retained for inspection.', { vaultId: vault.id, taskId }, error)))
    /** Allocates identity before native startup; model choice is never invented by this storage/lifecycle endpoint. */
    const prepareSession = Effect.fn('TaskService.prepareSession')(function* (input: OpenTaskSessionInput) {
      const task = yield* store.task(input.taskId)
      if (task.type !== 'agent') return yield* failure('invalid-state')
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
        if ((input.agent === 'pi') !== (input.model !== undefined)) return yield* failure('invalid-state')
        const modelProfile = input.model
          ? yield* models.resolveSessionModel(input.model).pipe(Effect.mapError((error) => new HarnessStoreError({ reason: 'invalid-state', message: error.message })))
          : null
        yield* store.createSession({
          id: input.sessionId,
          taskId: input.taskId,
          agent: input.agent,
          adapterVersion: agentPackage.version,
          purpose: 'task',
          syncOperationId: null,
          modelProfile
        })
      }
    })
    const openSession = Effect.fn('TaskService.openSession')(function* (input: OpenTaskSessionInput) {
      yield* prepareSession(input)
      const saved = (yield* store.sessions(input.taskId)).find((session) => session.id === input.sessionId)
      if (!saved) return yield* failure('not-found')
      return saved
    }, gate.withPermit)
    /** Checks Session ownership before returning any saved conversation content. */
    const history = Effect.fn('TaskService.history')(function* (taskId: string, sessionId: string) {
      yield* store.task(taskId)
      if (!(yield* store.sessions(taskId)).some((session) => session.id === sessionId)) return yield* failure('not-found')
      const messages = yield* events.messages(sessionId)
      return { messages }
    })
    /** Creates one operation-bound Session and lets the Agent edit only the isolated coordinator. */
    const startConflictResolution = Effect.fn('TaskService.startConflictResolution')(function* (input: StartConflictResolutionInput) {
      const task = yield* store.task(input.taskId)
      if (task.type !== 'agent') return yield* failure('invalid-state')
      const operation = yield* synchronization.get(input.operationId)
      if (operation.taskId !== task.id) return yield* failure('not-found')
      const savedSessions = yield* store.sessions(task.id)
      const source = savedSessions.find((session) => session.id === input.sourceSessionId)
      if (!source || source.purpose !== 'task' || source.agent !== task.configuration.agent) return yield* failure('invalid-state')
      const history = yield* store.runs(task.id)
      const previousRun = history.find(run => run.id === input.runId)
      if (previousRun) {
        const target = savedSessions.find(session => session.id === input.sessionId)
        if (previousRun.sessionId !== input.sessionId || previousRun.purpose !== 'conflict-resolution' || previousRun.resumesRunId !== null
          || target?.purpose !== 'conflict-resolution' || target.syncOperationId !== operation.id || target.agent !== source.agent) return yield* failure('invalid-state')
        // A retry of a successful Run can finish post-processing after a lost reply;
        // queue admission and execution history now refer to this same record.
        if (previousRun.state === 'succeeded' && operation.state === 'conflict') {
          yield* synchronization.acceptAgentResolution(task.id, operation.id, previousRun.id)
        }
        return previousRun
      }
      if (history.some(run => run.purpose === 'conflict-resolution' && run.endedAt === null)) return yield* failure('task-busy')
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
        yield* store.createSession({
          id: input.sessionId,
          taskId: task.id,
          agent: source.agent,
          adapterVersion: agentPackage.version,
          purpose: 'conflict-resolution',
          syncOperationId: operation.id,
          modelProfile: source.modelProfile ?? null
        })
      }
      const prompt = [
        'Resolve the current Git conflict for Folio by editing the working files in this directory.',
        '',
        `Task goal: ${task.configuration.goal}`,
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
      const request = yield* queue.submit({ ...intent, source: 'conflict-resolution' })
      yield* notifications.wake
      return request
    }, sql.withTransaction, Effect.mapError(safeError), gate.withPermit)
    /** Save definitions offline; capability health is checked when a Task actually prepares execution. */
    const saveRoutine = Effect.fn('TaskService.saveRoutine')(function* (input: SaveRoutine) {
      if (input.type === 'agent') {
        // Independent Skill selection is not mounted yet; refusing it avoids silently dropping intent.
        if (input.configuration.skillIds.length) return yield* failure('invalid-state')
        for (const reference of input.configuration.resourceIds) {
          const separator = reference.indexOf('/')
          const integrationId = separator > 0 ? reference.slice(0, separator) : ''
          const resourceId = separator > 0 ? reference.slice(separator + 1) : ''
          const view = (yield* integrations.list.pipe(Effect.mapError(safeError))).find((item) => item.id === integrationId)
          if (!view || !input.configuration.integrationIds.includes(integrationId)
            || !view.resources.some((resource) => resource.id === resourceId)
            || !view.record?.resources.some((resource) => resource.id === resourceId)) return yield* failure('invalid-state')
        }
      } else {
        const { integrationId, resourceId } = input.configuration
        const view = (yield* integrations.list.pipe(Effect.mapError(safeError))).find(item => item.id === integrationId)
        if (!view?.record?.resources.some(resource => resource.id === resourceId)
          || !view.resources.some(resource => resource.id === resourceId)) return yield* failure('invalid-state')
      }
      return yield* routines.save(input)
    })
    /** Creates one enabled hourly Ingestion Routine after a resource is actually ready. */
    const ensureDefaultRoutines = Effect.fn('TaskService.ensureDefaultRoutines')(function* () {
      const { timeZone } = yield* config.get.pipe(Effect.mapError(safeError))
      const available = yield* integrations.list.pipe(Effect.mapError(safeError))
      const current = yield* routines.list
      for (const view of available) {
        if (!view.record || view.record.error !== null || view.states[view.record.state]?.kind !== 'ready') continue
        for (const resource of view.record.resources) {
          if (!view.resources.some(candidate => candidate.id === resource.id)
            || current.some(routine => routine.type === 'ingestion'
              && routine.configuration.integrationId === view.id && routine.configuration.resourceId === resource.id)) continue
          yield* routines.save({
            id: randomUUID(), expectedRevision: null,
            name: `${view.name} · ${typeof resource.name === 'string' ? resource.name : resource.name['zh-CN'] ?? resource.name.en}`,
            type: 'ingestion', configuration: { integrationId: view.id, resourceId: resource.id },
            trigger: { type: 'schedule', intervalMinutes: 60, timeZone },
            enabled: true
          }).pipe(Effect.catchTag('HarnessStoreError', error => error.reason === 'invalid-state' ? Effect.void : Effect.fail(error)))
        }
      }
    }, gate.withPermit)
    /** Creates or coalesces one current execution, then optionally starts its Task Run. */
    const prepareRoutine = Effect.fn('TaskService.prepareRoutine')(function* (input: RunRoutine, mode: 'check' | 'settled' = 'check') {
      const execution = yield* routines.schedule(input.routineId, yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis)), mode)
      if (!execution) return null
      yield* Effect.logInfo('Routine extraction window reserved', {
        routineId: input.routineId, taskId: execution.taskId, timeZone: execution.timeZone,
        windowStart: routineTimestampAt(execution.windowStart, execution.timeZone),
        windowEnd: routineTimestampAt(execution.windowEnd, execution.timeZone),
        windowMs: execution.windowEnd - execution.windowStart,
        status: execution.status
      })
      // schedule reserves the Task atomically. Its configuration belongs to the
      // captured revision, even if the Routine was edited before admission/retry.
      const task = yield* store.task(execution.taskId)
      return { execution, task }
    })

    const ingestionNamespace = (task: Extract<TaskRecord, { type: 'ingestion' }>, routineDate: string) => {
      const { integrationId, resourceId } = task.configuration
      if (![integrationId, resourceId].every(value => /^[a-zA-Z0-9_-]+$/.test(value)) || !/^\d{4}-\d{2}-\d{2}$/.test(routineDate)) {
        throw failure('invalid-state')
      }
      return `raws/${integrationId}/${resourceId}/${routineDate}`
    }
    const saveIngestionReceiptUnlocked = Effect.fnUntraced(function* (
      taskId: string,
      update: (receipt: IngestionReceipt) => IngestionReceipt,
      state?: 'active' | 'completed' | 'cancelled',
      expectedStates?: readonly IngestionReceipt['state'][],
      changedFileCount = 0
    ) {
      const task = yield* store.task(taskId)
      if (task.type !== 'ingestion') return yield* failure('invalid-state')
      if (expectedStates && !expectedStates.includes(task.receipt.state)) return yield* failure('invalid-state')
      const receipt = update(task.receipt)
      yield* sql`UPDATE tasks SET receipt=${JSON.stringify(receipt)},
        state=COALESCE(${state ?? null}, state) WHERE id=${taskId} AND type='ingestion'`
      if (['succeeded', 'failed', 'interrupted', 'cancelled', 'conflict'].includes(receipt.state)) {
        const execution = yield* routines.executionForTask(taskId)
        if (!execution || receipt.endedAt === null) return yield* failure('invalid-state')
        const summary = yield* Effect.mapError(Schema.decodeUnknownEffect(TaskSummary)({
          type: 'ingestion', windowStart: execution.windowStart, windowEnd: execution.windowEnd,
          timeZone: execution.timeZone, attemptCount: receipt.attemptCount, endedAt: receipt.endedAt,
          outcome: receipt.state, error: receipt.error,
          rawsChanged: receipt.state === 'succeeded' && changedFileCount > 0,
          changedFileCount: receipt.state === 'succeeded' ? changedFileCount : 0,
          publication: { state: receipt.state === 'succeeded' ? receipt.changeId ? 'completed' : 'not-required'
            : receipt.state === 'conflict' ? 'conflict' : 'failed',
          saveOperationId: receipt.changeId, synchronizationId: null }
        }), safeError)
        yield* sql`UPDATE tasks SET summary=${JSON.stringify(summary)} WHERE id=${taskId} AND type='ingestion'`
      }
      return receipt
    })
    const saveIngestionReceipt = Effect.fn('TaskService.saveIngestionReceipt')(function* (
      taskId: string,
      update: (receipt: IngestionReceipt) => IngestionReceipt,
      state?: 'active' | 'completed' | 'cancelled',
      expectedStates?: readonly IngestionReceipt['state'][]
    ) {
      return yield* sql.withTransaction(saveIngestionReceiptUnlocked(taskId, update, state, expectedStates))
    }, ingestionReceiptGate.withPermit)
    const rawPaths = Effect.fn('TaskService.rawPaths')(function* (task: Extract<TaskRecord, { type: 'ingestion' }>, namespace: string) {
      const tracked = (yield* git(task.worktree, ['diff', '--name-only', '--no-renames', '-z', 'HEAD'])).split('\0').filter(Boolean)
      const untracked = (yield* git(task.worktree, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
      const paths = [...new Set([...tracked, ...untracked])].sort()
      if (paths.some(path => !path.startsWith(`${namespace}/`))) return yield* failure('invalid-state')
      return paths
    })
    const finishIngestionSuccess = Effect.fn('TaskService.finishIngestionSuccess')(function* (
      task: Extract<TaskRecord, { type: 'ingestion' }>, publishedHead: string, paths: readonly string[]
    ) {
      const time = yield* now
      // A mutable working tree can advance immediately after publication. Derive presence
      // from the immutable canonical tree named by current_commit instead.
      const states = yield* Effect.forEach(paths, Effect.fnUntraced(function* (path) {
        const entries = (yield* git(join(vault.directory, 'workspace'), [
          '--literal-pathspecs', 'ls-tree', '-z', publishedHead, '--', path
        ])).split('\0').filter(Boolean)
        if (!entries.length) return { path, state: 'deleted' as const }
        if (entries.length !== 1 || !/^100(?:644|755) blob [a-f0-9]+\t/.test(entries[0]!)) return yield* failure('invalid-state')
        return { path, state: 'present' as const }
      }))
      yield* sql.withTransaction(Effect.gen(function* () {
        for (const value of states) {
          yield* sql`INSERT INTO raws (id, integration_id, resource_id, path, state, current_commit, created_at, updated_at)
            VALUES (${uuidv7()}, ${task.configuration.integrationId}, ${task.configuration.resourceId}, ${value.path}, ${value.state}, ${publishedHead}, ${time}, ${time})
            ON CONFLICT(path) DO UPDATE SET state=excluded.state, current_commit=excluded.current_commit, updated_at=excluded.updated_at`
        }
        yield* saveIngestionReceiptUnlocked(task.id, receipt => ({ ...receipt, state: 'succeeded', cancelRequested: false,
          endedAt: time, error: null, observedHead: receipt.changeId === null ? publishedHead : null }), 'completed', undefined, paths.length)
      }))
    }, ingestionReceiptGate.withPermit)

    /** One fiber owns a Task attempt; interruption is converted into a durable receipt before exit. */
    const executeIngestion = Effect.fn('TaskService.executeIngestion')(function* (taskId: string) {
      return yield* Effect.uninterruptibleMask(restore => Effect.gen(function* () {
        const execution = yield* routines.executionForTask(taskId)
        let task = yield* store.task(taskId)
        if (!execution || task.type !== 'ingestion' || execution.windowStart === null || execution.windowEnd === null) return yield* failure('invalid-state')
        const windowStart = execution.windowStart
        const windowEnd = execution.windowEnd
        const namespace = ingestionNamespace(task, execution.routineDate)
        const previousState = task.receipt.state
        const startedAt = yield* now
        yield* saveIngestionReceipt(taskId, receipt => ({ ...receipt, state: 'running', attemptCount: receipt.attemptCount + 1,
          cancelRequested: false, startedAt, endedAt: null, error: null }), 'active')
        let stage = 'prepare-worktree'
        const attempt = yield* Effect.gen(function* () {
          const prepared = yield* restore(Effect.gen(function* () {
            task = yield* store.task(taskId)
            if (task.type !== 'ingestion') return yield* failure('invalid-state')
            let operation = (yield* synchronization.pending).filter(value => value.taskId === taskId).at(-1)
            let paths: readonly string[] = []
            if (operation?.state === 'conflict') {
              // Only an explicit Retry persists pending over a retained conflict. Crash recovery
              // observes running/conflict and must preserve the evidence without replaying it.
              if (previousState !== 'pending') return { kind: 'conflict' as const }
              operation = yield* synchronization.reprepare({ id: randomUUID(), taskId, supersededId: operation.id })
            }
            if (!operation) {
              if (task.receipt.changeId === null) {
                const checkout = previousState === 'pending' && task.receipt.attemptCount === 1
                  ? yield* worktrees.ensure(taskId)
                  : yield* worktrees.resetIngestion(taskId, namespace)
                stage = 'ingest-provider'
                yield* integrations.ingest(task.configuration.integrationId, task.configuration.resourceId,
                  join(checkout.path, namespace), { start: windowStart, end: windowEnd, timeZone: execution.timeZone })
                stage = 'commit-raws'
                paths = yield* rawPaths(task, namespace)
                if (paths.length) {
                  const application = yield* changes.saveTaskRaws({ id: randomUUID(), taskId,
                    expectedParent: (yield* git(task.worktree, ['rev-parse', 'HEAD'])).trim(), paths: paths as [string, ...string[]] })
                  yield* saveIngestionReceipt(taskId, receipt => ({ ...receipt, changeId: application.id }))
                }
              }
              stage = 'prepare-publication'
              const sourceHead = (yield* git(task.worktree, ['rev-parse', 'HEAD'])).trim()
              operation = yield* synchronization.prepare({ id: randomUUID(), taskId, expectedSourceHead: sourceHead })
            } else if (operation.state === 'pending') {
              operation = yield* synchronization.prepare({ id: operation.id, taskId, expectedSourceHead: operation.sourceHead })
            }
            if (operation.state === 'conflict') return { kind: 'conflict' as const }
            return { kind: 'prepared' as const, operation, paths }
          }))
          if (prepared.kind === 'conflict') return prepared
          let { operation, paths } = prepared
          // Canonical publication wins a concurrent Stop. From this point through the
          // successful SQLite receipt, interruption must not expose a cancelled window.
          stage = 'publish-raws'
          if (operation.state === 'prepared') operation = yield* synchronization.publish(operation.id)
          if (!operation.publishedHead || !['published', 'completed'].includes(operation.state)) return yield* failure('invalid-state')
          const current = yield* store.task(taskId)
          if (current.type !== 'ingestion') return yield* failure('invalid-state')
          if (!paths.length && current.receipt.changeId) {
            const saved = (yield* sql<{ source: string; target: string }>`SELECT source_commit AS source, target_commit AS target
              FROM git_operations WHERE id=${current.receipt.changeId} AND task_id=${taskId}
                AND kind='save-raws' AND state='completed'`)[0]
            if (saved) paths = (yield* git(task.worktree, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', saved.source, saved.target]))
              .split('\0').filter(Boolean)
          }
          stage = 'save-receipt'
          yield* finishIngestionSuccess(current, operation.publishedHead, paths)
          // Business success is already durable. Alignment and release are recoverable cleanup.
          yield* synchronization.align(operation.id).pipe(Effect.andThen(worktrees.complete(taskId)), Effect.catch(error =>
            Effect.logWarning('Successful Ingestion cleanup will be retried.', { taskId, operationId: operation.id }, error)))
          return { kind: 'succeeded' as const }
        }).pipe(Effect.exit)
        if (Exit.isSuccess(attempt)) {
          if (attempt.value.kind === 'conflict') {
            const endedAt = yield* now
            yield* saveIngestionReceipt(taskId, receipt => ({ ...receipt, state: 'conflict', endedAt,
              error: 'Raw publication conflicts with newer Vault changes.' }))
            return
          }
          const next = yield* routines.schedule(execution.routineId, yield* now, 'settled')
          if (next?.type === 'ingestion') yield* startIngestion(next.taskId)
          return
        }
        const latest = yield* store.task(taskId)
        if (latest.type !== 'ingestion' || latest.receipt.state === 'succeeded') return
        const cancelled = latest.receipt.cancelRequested
        const interrupted = Cause.hasInterrupts(attempt.cause)
        const endedAt = yield* now
        yield* saveIngestionReceipt(taskId, receipt => ({ ...receipt,
          state: cancelled ? 'cancelled' : interrupted ? 'interrupted' : 'failed',
          endedAt, error: cancelled ? null : interrupted ? 'The ingestion attempt was interrupted.' : 'The ingestion attempt failed.'
        }), cancelled ? 'cancelled' : 'active')
        if (!interrupted) {
          const error = Cause.squash(attempt.cause)
          yield* Effect.logError('Ingestion attempt failed; the exact window remains retryable.', {
            taskId, stage, integration: task.configuration.integrationId, resource: task.configuration.resourceId,
            windowStart, windowEnd, attemptCount: latest.receipt.attemptCount,
            reason: error instanceof HarnessStoreError ? error.reason : 'operation-failed',
            message: error instanceof HarnessStoreError ? error.message : 'See provider stage logs'
          })
        }
      }))
    })
    function startIngestion(taskId: string): Effect.Effect<void, HarnessStoreError> {
      return Effect.gen(function* () {
        if (ingestionFibers.has(taskId)) return
        const fiber = yield* executeIngestion(taskId).pipe(
          Effect.catch(error => Effect.logError('Ingestion receipt recovery failed.', { taskId }, error)),
          Effect.ensuring(Effect.sync(() => { ingestionFibers.delete(taskId) })),
          Effect.forkIn(scope)
        )
        ingestionFibers.set(taskId, fiber)
      }).pipe(Effect.withSpan('TaskService.startIngestion'), Effect.mapError(safeError))
    }
    const admitRoutine = Effect.fn('TaskService.admitRoutine')(function* (input: RunRoutine, mode: 'check' | 'settled' = 'check') {
      if (input.requestId) {
        const previous = yield* queue.get(input.requestId).pipe(Effect.catchTag('HarnessStoreError', error => error.reason === 'not-found' ? Effect.succeed(null) : Effect.fail(error)))
        if (previous) {
          const execution = yield* routines.executionForTask(previous.taskId)
          if (!execution || execution.routineId !== input.routineId || previous.source !== 'routine') return yield* failure('invalid-state')
          return { execution, task: yield* store.task(previous.taskId), run: previous }
        }
      }
      const prepared = yield* prepareRoutine(input, mode)
      if (!prepared) return null
      const { execution, task } = prepared
      if (task.type === 'ingestion') {
        return { execution, task, run: null }
      }
      const pending = (yield* queue.list(task.id)).find(request => request.endedAt === null)
      if (pending) return { execution, task, run: pending }
      const sessionId = randomUUID()
      const runId = input.requestId ?? randomUUID()
      const prompt = `${task.configuration.goal}\n\nRoutine execution window (use this timezone and these exact ISO timestamps for extraction):\n- time-zone: ${execution.timeZone}\n- start: ${routineTimestampAt(execution.windowStart, execution.timeZone)}\n- end: ${routineTimestampAt(execution.windowEnd, execution.timeZone)}`
      yield* prepareSession({ taskId: task.id, sessionId, agent: task.configuration.agent, ...(execution.model ? { model: execution.model } : {}) })
      const run = yield* queue.submit({ id: runId, taskId: task.id, sessionId, prompt, purpose: 'execution', resumesRunId: null, source: 'routine' })
      return { execution: (yield* routines.executionForTask(task.id))!, task, run }
    })
    /** Starts host-owned work only after admission commits, so the fiber never inherits a transaction connection. */
    const submitRoutine = Effect.fn('TaskService.submitRoutine')(function* (input: RunRoutine, mode: 'check' | 'settled' = 'check') {
      const result = yield* admitRoutine(input, mode).pipe(sql.withTransaction)
      if (result?.task.type === 'ingestion') yield* startIngestion(result.task.id)
      return result
    },
      (effect, input, _mode: 'check' | 'settled' = 'check') => effect.pipe(Effect.tapError(error => Effect.logWarning('Routine submission failed', { vaultId: vault.id, routineId: input.routineId }, error))),
      Effect.mapError(safeError), gate.withPermit, Effect.tap(() => notifications.wake))
    const runRoutine = (input: RunRoutine) => submitRoutine(input).pipe(Effect.flatMap(result => result
      ? Effect.succeed(result) : Effect.fail(new HarnessStoreError({ reason: 'invalid-state', message: 'No unprocessed time window is available.' }))))
    /** Replayable post-processing is derived from durable requests, never an in-memory callback. */
    const settleSuccessfulExecution = (request: RunRecord) => Effect.gen(function* () {
      if (request.purpose === 'conflict-resolution') {
        const session = (yield* store.sessions(request.taskId)).find(value => value.id === request.sessionId)
        if (!session?.syncOperationId) return yield* failure('invalid-state')
        const operation = yield* synchronization.get(session.syncOperationId)
        if (operation.state === 'conflict') {
          yield* synchronization.acceptAgentResolution(request.taskId, session.syncOperationId, request.id)
        }
      }
      const execution = yield* routines.executionForTask(request.taskId)
      yield* completeRoutineAfterReceipt(request.taskId)
      if (execution) {
        // A completed window may have accumulated a full hour of backlog while
        // the Agent was running. schedule() caps this follow-up to one window.
        yield* submitRoutine({ routineId: execution.routineId }, 'settled').pipe(Effect.catch(error => Effect.logWarning('Routine catch-up admission will be retried.', error)))
      }
    })
    /** A user stop intentionally abandons the current window as a repair gap. */
    const settleCancelledRoutine = (taskId: string) => Effect.gen(function* () {
      const execution = yield* routines.executionForTask(taskId)
      if (!execution) return
      // Keep the stopped worktree and partial output for inspection/repair.
      // schedule() decides whether the stopped boundary is old enough to start one
      // follow-up window. A short delta intentionally waits for the regular check.
      yield* submitRoutine({ routineId: execution.routineId }, 'settled').pipe(Effect.catch(error => Effect.logWarning('Routine catch-up admission will be retried.', error)))
    })
    /** A global slot is held until Run cleanup and the durable terminal receipt both complete. */
    const executeRequest = (request: RunRecord) => Effect.uninterruptibleMask(restore => Effect.gen(function* () {
      const current = yield* queue.get(request.id)
      if (current.owner !== request.owner || current.state !== 'preparing' || !request.owner) return yield* failure('invalid-state')
      yield* sink.begin(current)
      const result = yield* restore(Effect.gen(function* () {
        if (current.cancelRequested) return
        const worker = yield* runs.execute(request).pipe(Effect.forkScoped)
        yield* Effect.gen(function* () {
          while (true) {
            const latest = yield* queue.get(request.id)
            if (latest.cancelRequested) {
              yield* runs.cancel(request.taskId, request.id).pipe(Effect.catch(() => Effect.void))
              yield* Fiber.interrupt(worker)
              return
            }
            yield* Effect.sleep(100)
          }
        }).pipe(Effect.forkScoped)
        yield* Fiber.join(worker)
      }).pipe(Effect.scoped, Effect.exit))
      const latest = yield* queue.get(request.id)
      const fallback = latest.cancelRequested ? 'cancelled'
        : latest.baselineCommit !== null || (Exit.isFailure(result) && Cause.hasInterrupts(result.cause)) ? 'interrupted' : 'failed'
      const executionError = Exit.isFailure(result) ? Cause.pretty(result.cause) : undefined
      if (executionError) yield* Effect.logError('Task Worker execution failed', { vaultId: vault.id, taskId: request.taskId, runId: request.id }, executionError)
      yield* sink.finishRequest(request, fallback, executionError)
      if ((yield* queue.get(request.id)).state === 'succeeded') yield* settleSuccessfulExecution(request)
      else if ((yield* queue.get(request.id)).state === 'cancelled') yield* settleCancelledRoutine(request.taskId)
    })).pipe(Effect.ensuring(Effect.sync(() => { ownedExecutions.delete(request.id) })))
    const dispatchRoutine = Effect.fn('TaskService.dispatchRoutine')(function* (id: string) {
      return yield* submitRoutine({ routineId: id })
    })
    const checkedDates = new Map<string, string>()
    // Startup and a new civil day check immediately, regardless of a stale future cursor.
    const tickRoutines = Effect.gen(function* () {
      yield* ensureDefaultRoutines()
      // A crash may land after the final Run receipt but before worktree release. Reconcile
      // durable Routine state before admitting another batch; one dirty Task cannot stop peers.
      for (const task of yield* store.tasks) {
        if (task.type === 'agent') yield* completeRoutineAfterReceipt(task.id)
        else if (task.state === 'completed' && task.worktreeState !== 'released') {
          const rows = yield* sql<{ id: string; state: string }>`SELECT id, state FROM git_operations
            WHERE task_id=${task.id} ORDER BY sequence DESC LIMIT 1`
          const operation = rows[0]
          if (operation?.state === 'published') {
            yield* synchronization.align(operation.id).pipe(Effect.catch(() => Effect.void))
          }
          yield* worktrees.complete(task.id).pipe(Effect.catch(() => Effect.void))
        }
      }
      const current = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis))
      for (const routine of yield* routines.list) {
        if (!routine.enabled) continue
        const today = routineDateAt(current, routine.trigger.timeZone)
        const due = checkedDates.get(routine.id) !== today || routine.nextTriggerAt === null || routine.nextTriggerAt <= current
        // A normal scheduler tick is only a check. Settled execution is handled
        // once by the terminal receipt path; re-evaluating it on every tick
        // would turn a short post-success gap into an unintended one-hour
        // catch-up once wall clock time advances.
        if (due) {
          yield* submitRoutine({ routineId: routine.id }, 'check').pipe(
            Effect.tap(() => Effect.sync(() => { checkedDates.set(routine.id, today) })),
            Effect.catch(error => Effect.logWarning('Routine dispatch could not complete; its execution remains retryable.', { vaultId: vault.id, routineId: routine.id }, error)))
        }
      }
    }).pipe(Effect.mapError(safeError))
    /** Returns only this Task's actionable operation after proving the Task belongs to the Vault. */
    const pendingTaskSynchronizations = Effect.fn('TaskService.pendingTaskSynchronizations')(function* (taskId: string) {
      yield* store.task(taskId)
      return (yield* synchronization.pending).filter((operation) => operation.taskId === taskId)
    })
    /** Only a save attributed to the displayed Run may alter its publication snapshot. */
    const recordWikiSave = Effect.fn('TaskService.recordWikiSave')(function* (taskId: string, runIds: readonly string[], saveId: string) {
      const task = yield* store.task(taskId)
      if (task.summary?.type !== 'agent' || !runIds.includes(task.summary.runId)) return
      yield* sql`UPDATE tasks SET summary=json_set(summary, '$.publication.saveOperationId', ${saveId},
        '$.publication.state', 'pending') WHERE id=${taskId} AND json_extract(summary, '$.runId')=${task.summary.runId}`
    }, Effect.mapError(safeError))
    /** Git owns the operation history; this only updates the matching Task-level result. */
    const recordWikiSynchronization = Effect.fn('TaskService.recordWikiSynchronization')(function* (operation: { id: string; taskId: string; sourceHead: string; state: string }) {
      const task = yield* store.task(operation.taskId)
      if (task.summary?.type !== 'agent' || !task.summary.publication.saveOperationId) return false
      const summary = task.summary
      const saveId = summary.publication.saveOperationId
      const owners = yield* sql<{ runId: string; saveCommit: string }>`SELECT owner.run_id AS runId,
        save.target_commit AS saveCommit FROM git_operations save
        JOIN git_operation_runs owner ON owner.operation_id=save.id
        WHERE save.id=${saveId} AND save.task_id=${operation.taskId} AND save.kind='save-wiki'`
      const ownedSave = owners.find(owner => owner.runId === summary.runId)
      if (!ownedSave) return false
      // A synchronization can include several sequential saves, so its source
      // head need only descend from this Run's attributed save commit. Use the
      // registered main checkout: a settled Routine may have released its worktree.
      if ((yield* git(join(vault.directory, 'workspace'), ['merge-base', ownedSave.saveCommit, operation.sourceHead])).trim() !== ownedSave.saveCommit) return false
      const publicationState = operation.state === 'completed' ? 'completed'
        : operation.state === 'conflict' ? 'conflict' : operation.state === 'aborted' ? 'failed' : 'pending'
      yield* sql`UPDATE tasks SET summary=json_set(summary, '$.publication.synchronizationId', ${operation.id},
        '$.publication.state', ${publicationState}) WHERE id=${operation.taskId}
          AND json_extract(summary, '$.runId')=${summary.runId}
          AND json_extract(summary, '$.publication.saveOperationId')=${saveId}`
      return true
    }, Effect.mapError(safeError))
    /** A damaged operation should not make unrelated Tasks or the Vault unavailable. */
    const reconcilePublicationSummary = Effect.fn('TaskService.reconcilePublicationSummary')(function* (id: string) {
      const task = yield* store.task(id)
      if (task.summary?.type !== 'agent') return
      const runId = task.summary.runId
      const saves = yield* sql<{ id: string }>`SELECT save.id FROM git_operations save
        JOIN git_operation_runs owner ON owner.operation_id=save.id
        WHERE save.task_id=${id} AND save.kind='save-wiki' AND save.state='completed'
          AND owner.run_id=${runId} ORDER BY save.sequence DESC LIMIT 1`
      if (!saves[0]) {
        const run = (yield* store.runs(id)).find(value => value.id === runId)
        if (run?.syncState === 'not-required' && task.summary.publication.state === 'pending') {
          yield* markWikiUnchanged(id, runId)
        }
        return
      }
      if (task.summary.publication.saveOperationId !== saves[0].id) yield* recordWikiSave(id, [runId], saves[0].id)
      const synchronizations = yield* sql<{ id: string; sourceHead: string; state: string }>`SELECT id,
        source_commit AS sourceHead, state FROM git_operations
        WHERE task_id=${id} AND kind='synchronize' ORDER BY sequence DESC`
      for (const operation of synchronizations) {
        if (yield* recordWikiSynchronization({ ...operation, taskId: id })) break
      }
    }, Effect.mapError(safeError))
    /** Replays committed Git/Run receipts into the Task snapshot after a process exits between writes. */
    const reconcilePublicationSummaries = Effect.fn('TaskService.reconcilePublicationSummaries')(function* () {
      const rows = yield* sql<{ id: string }>`SELECT id FROM tasks WHERE type='agent'
        AND json_extract(summary, '$.type')='agent' ORDER BY created_at, id`
      for (const { id } of rows) {
        yield* reconcilePublicationSummary(id).pipe(Effect.catch(error => Effect.logWarning(
          'Task publication summary could not be reconciled; the saved snapshot remains available.', { vaultId: vault.id, taskId: id }, error)))
      }
    }, Effect.mapError(safeError))
    /** Conflict actions require both identities so a caller cannot operate on another Task's receipt. */
    const conflictAction = Effect.fn('TaskService.conflictAction')(function* (taskId: string, id: string, action: 'resolve' | 'abort') {
      const task = yield* store.task(taskId)
      if (task.type !== 'agent') return yield* failure('invalid-state')
      const operation = yield* synchronization.get(id)
      if (operation.taskId !== taskId) return yield* failure('not-found')
      const settled = yield* action === 'resolve' ? synchronization.resolve(id) : synchronization.abort(id)
      yield* recordWikiSynchronization(settled)
      if (settled.state === 'completed') yield* completeRoutineAfterReceipt(taskId)
      return settled
    })
    const cancelIngestion = Effect.fn('TaskService.cancelIngestion')(function* (taskId: string) {
      const task = yield* store.task(taskId)
      if (task.type !== 'ingestion' || !['pending', 'running'].includes(task.receipt.state)) return yield* failure('invalid-state')
      yield* saveIngestionReceipt(taskId, receipt => ({ ...receipt, cancelRequested: true }), undefined, ['pending', 'running'])
      const fiber = ingestionFibers.get(taskId)
      if (fiber) yield* Fiber.interrupt(fiber)
      else {
        const endedAt = yield* now
        yield* saveIngestionReceipt(taskId, receipt => ({ ...receipt, state: 'cancelled', endedAt }), 'cancelled')
      }
      return yield* store.task(taskId)
    }, gate.withPermit, Effect.mapError(safeError))
    const retryIngestion = Effect.fn('TaskService.retryIngestion')(function* (taskId: string) {
      const task = yield* store.task(taskId)
      if (task.type !== 'ingestion' || !['failed', 'interrupted', 'cancelled', 'conflict'].includes(task.receipt.state)
        || ingestionFibers.has(taskId)) return yield* failure('invalid-state')
      yield* saveIngestionReceipt(taskId, receipt => ({ ...receipt, state: 'pending', cancelRequested: false,
        startedAt: null, endedAt: null, error: null, observedHead: null }), 'active')
      yield* startIngestion(taskId)
      return yield* store.task(taskId)
    }, gate.withPermit, Effect.mapError(safeError))
    yield* reconcilePublicationSummaries()
    return TaskService.of({
      executionCounts: queue.counts,
      tickRoutines,
      dispatchRoutine,
      runRoutine,
      executeRequest,
      recoverExecutionState: Effect.gen(function* () {
        yield* recoverExecutions({ workers, owned: ownedExecutions, queue, sink, store, runs, sessions, files: runFiles })
        return (yield* queue.list()).filter(request => request.state !== 'queued' && request.endedAt === null && !ownedExecutions.has(request.id)).length
      }).pipe(gate.withPermit, Effect.mapError(safeError), Effect.tap(() => Effect.gen(function* () {
        for (const request of yield* queue.list()) {
          if (request.state === 'succeeded') yield* settleSuccessfulExecution(request).pipe(
            Effect.catch(() => Effect.logWarning('Execution post-processing remains pending for a later recovery sweep.')))
        }
      }))),
      claimExecution: owner => Effect.gen(function* () {
        yield* recoverExecutions({ workers, owned: ownedExecutions, queue, sink, store, runs, sessions, files: runFiles })
        const request = yield* queue.claim(owner)
        if (request) ownedExecutions.add(request.id)
        return request
      }).pipe(gate.withPermit, Effect.uninterruptible, Effect.mapError(safeError)),
      prepareRoutine: (input) => prepareRoutine(input).pipe(Effect.flatMap(result => result ? Effect.succeed(result) : Effect.fail(failure('invalid-state'))), sql.withTransaction, Effect.mapError(safeError), gate.withPermit),
      routineExecutions: routines.executions,
      allRoutineExecutions: routines.allExecutions,
      routines: ensureDefaultRoutines().pipe(Effect.andThen(routines.list)),
      ensureDefaultRoutine: ensureDefaultRoutines(),
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
      saveRunWikiFiles: (input) => changes.saveRunWiki(input).pipe(Effect.tap(saved => recordWikiSave(input.taskId, input.runIds, saved.id))),
      confirmRunWikiUnchanged: (input) => changes.confirmRunWikiUnchanged(input).pipe(
        Effect.tap(() => markWikiUnchanged(input.taskId, input.runId)),
        Effect.tap(() => completeRoutineAfterReceipt(input.taskId))),
      synchronizeTaskWiki: (input) => synchronization.synchronize(input).pipe(
        Effect.tap(recordWikiSynchronization),
        Effect.tap((operation) => operation.state === 'completed' ? completeRoutineAfterReceipt(input.taskId) : Effect.void)),
      reprepareTaskWiki: (input) => synchronization.reprepare(input).pipe(
        Effect.tap(recordWikiSynchronization),
        Effect.tap((operation) => operation.state === 'completed' ? completeRoutineAfterReceipt(input.taskId) : Effect.void)),
      resolveTaskWikiConflict: (taskId, id) => conflictAction(taskId, id, 'resolve'),
      abortTaskWikiConflict: (taskId, id) => conflictAction(taskId, id, 'abort'),
      cancelIngestion,
      retryIngestion,
      pendingTaskSynchronizations,
      taskSynchronization: synchronization.get,
      history,
      list: store.tasks,
      feed,
      create: (input) => create(input).pipe(gate.withPermit),
      complete,
      reopen,
      get,
      openSession,
      closeSession: sessions.close,
      startRun: (input) => queue.submit({ ...input, source: input.purpose === 'recovery' ? 'recovery' : 'manual' }).pipe(gate.withPermit, Effect.tap(() => notifications.wake)),
      startConflictResolution,
      inspectRun: (taskId, runId) => Effect.gen(function* () {
        yield* runs.inspect(taskId, runId)
        yield* recoverExecutions({ workers, owned: ownedExecutions, queue, sink, store, runs, sessions, files: runFiles })
        return yield* queue.get(runId)
      }).pipe(Effect.mapError(safeError)),
      cancelRun: (taskId, runId) => Effect.gen(function* () {
        const request = yield* queue.get(runId)
        if (request.taskId !== taskId) return yield* failure('not-found')
        const cancelled = yield* sql.withTransaction(Effect.gen(function* () {
          const result = yield* queue.cancel(runId)
          if (request.state === 'queued' && result.state === 'cancelled') {
            yield* store.recordAgentSummary(result, yield* events.messages(result.sessionId))
          }
          return result
        })).pipe(Effect.mapError(safeError))
        yield* sink.cancellation(cancelled).pipe(Effect.catch(() => Effect.logWarning('Cancellation was saved but its diagnostic log could not be written.')))
        // Only a queued request terminates here. Active requests settle in the
        // Worker exit path, and repeated stop RPCs must not advance again.
        if (request.state === 'queued' && cancelled.state === 'cancelled') yield* settleCancelledRoutine(taskId)
        yield* notifications.wake
        return cancelled
      })
    })
  })
)
