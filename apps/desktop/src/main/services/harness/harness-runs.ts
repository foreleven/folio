import { ExecutionEventSink } from '../execution/execution-event-sink'
import { RecordedUpdate } from '../../../shared/harness-events'
import { randomUUID } from 'node:crypto'
import { SessionUpdate } from '@agentclientprotocol/sdk/experimental/v2'
import { Context, Deferred, Effect, Exit, FileSystem, Fiber, Layer, Schema, Scope, Semaphore } from 'effect'
import { HarnessStoreError, type RunIntent, type RunOutcome, type RunRecord } from '../../../shared/harness'
import { HarnessStore } from './harness-store'
import { HarnessSessions } from './harness-sessions'
import { HarnessEventStore } from './harness-event-store'
import { TaskWorktrees } from '../tasks/task-worktrees'
import { makeVaultGit } from '../git/vault-git'
import { SqlClient } from 'effect/unstable/sql'
import { isRegisteredGitCommit } from '../git/git-change-applications'
import { join } from 'node:path'

interface Entry {
  readonly input: RunIntent
  readonly ready: Deferred.Deferred<RunRecord, HarnessStoreError>
  lifetime: Fiber.Fiber<void>
  cancelled: boolean
  cancelling?: Fiber.Fiber<void>
}
const failure = (reason: HarnessStoreError['reason']) => new HarnessStoreError({ reason,
  message: reason === 'task-busy' ? 'This Task already has an active Run.'
    : reason === 'invalid-state' ? 'This Run requires inspection before it can continue.'
      : 'Could not execute this Run. Its saved state has been retained.' })
const executionInterrupted = Schema.is(Schema.Struct({ 'folio/executionInterrupted': Schema.Literal(true) }))
const safeError = (error: unknown) => error instanceof HarnessStoreError ? error : failure('storage')
/** Retry identity includes intent, not a new baseline or a second dispatch. */
function matches(left: RunIntent, right: RunIntent): boolean {
  return left.id === right.id && left.taskId === right.taskId && left.sessionId === right.sessionId
    && left.prompt === right.prompt && left.purpose === right.purpose && left.resumesRunId === right.resumesRunId
}

/**
 * Owns Prompt lifetimes outside RPC/window scopes. A terminal Run records foreground execution;
 * sync remains pending and no Git write follows idle. Every terminal path reaps the owned Agent
 * process group before publishing the Run outcome; a later turn resumes the persisted Session.
 * A tool that deliberately escapes into another process group remains outside this proof.
 */
export class HarnessRuns extends Context.Service<HarnessRuns, {
  readonly execute: (input: RunIntent) => Effect.Effect<RunRecord, HarnessStoreError>
  readonly inspect: (taskId: string, runId: string) => Effect.Effect<RunRecord, HarnessStoreError>
  readonly cancel: (taskId: string, runId: string) => Effect.Effect<RunRecord, HarnessStoreError>
}>()('folio/services/HarnessRuns') {
  static readonly layer = Layer.effect(HarnessRuns, Effect.gen(function*() {
    const owner = yield* Scope.Scope
    const store = yield* HarnessStore
    const sessions = yield* HarnessSessions
    const events = yield* HarnessEventStore
    const sink = yield* ExecutionEventSink
    const worktrees = yield* TaskWorktrees
    const fs = yield* FileSystem.FileSystem
    const git = yield* makeVaultGit
    const sql = yield* SqlClient.SqlClient
    const gate = yield* Semaphore.make(1)
    const entries = new Map<string, Entry>()
    let shuttingDown = false

    /** Reads the persisted record after an application-owned operation, including uncertain failures. */
    const read = Effect.fn('HarnessRuns.read')(function*(taskId: string, id: string) {
      const run = (yield* store.runs(taskId)).find(value => value.id === id)
      if (!run) return yield* failure('not-found')
      return run
    })

    /** Performs short admission checks; the worker and its cleanup do not hold the Vault gate. */
    const begin = Effect.fn('HarnessRuns.begin')(function*(input: RunIntent) {
      if (shuttingDown) return yield* failure('invalid-state')
      const pending = entries.get(input.id)
      if (pending) {
        if (!matches(pending.input, input)) return yield* failure('invalid-state')
        return pending.ready
      }
      const previous = (yield* store.runs(input.taskId)).find(run => run.id === input.id)
      if (previous && previous.state !== 'preparing') {
        if (!matches(previous, input)) return yield* failure('invalid-state')
        return yield* Deferred.make<RunRecord, HarnessStoreError>().pipe(
          Effect.tap(ready => Deferred.succeed(ready, previous)))
      }
      if (!previous || previous.state !== 'preparing' || !previous.owner) return yield* failure('invalid-state')
      const claim = { id: previous.id, owner: previous.owner }
      if ([...entries.values()].some(entry => entry.input.taskId === input.taskId)) return yield* failure('task-busy')
      const ready = yield* Deferred.make<RunRecord, HarnessStoreError>()
      const entry: Entry = { input, ready, cancelled: false, lifetime: undefined! }
      let prompt: Promise<unknown> | undefined
      let opened = false
      const execute = Effect.gen(function*() {
        const savedSession = (yield* store.sessions(input.taskId)).find((session) => session.id === input.sessionId)
        if (!savedSession) return yield* failure('not-found')
        let baseline: string
        let taskWorktree: string | undefined
        if (input.purpose === 'conflict-resolution') {
          if (savedSession.purpose !== 'conflict-resolution' || !savedSession.syncOperationId) return yield* failure('invalid-state')
          const target = (yield* sql<{ mainBase: string; canonicalCommits: string }>`SELECT main_base AS mainBase,
            canonical_commits AS canonicalCommits FROM git_sync_operations
            WHERE id=${savedSession.syncOperationId} AND task_id=${input.taskId} AND state='conflict'`)[0]
          if (!target) return yield* failure('invalid-state')
          const prefix = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.Struct({ commit: Schema.String }))))(target.canonicalCommits)
          baseline = prefix.at(-1)?.commit ?? target.mainBase
        } else {
          if (savedSession.purpose !== 'task') return yield* failure('invalid-state')
          const checkout = yield* worktrees.ensure(input.taskId, claim)
          taskWorktree = checkout.path
          // Only completed save receipts extend the registered baseline; a prepared object is insufficient.
          baseline = (yield* git(checkout.path, ['rev-parse', 'HEAD'])).trim()
          if (!(yield* isRegisteredGitCommit(checkout.branch, baseline, checkout.baselineCommit).pipe(
            Effect.provideService(SqlClient.SqlClient, sql)))) return yield* failure('invalid-state')
        }
        opened = true
        const session = yield* sessions.open(input.taskId, input.sessionId, claim)
        // Provider onIngest hooks can add a short-lived instruction file after
        // resource preparation. Prefix it at the ACP boundary so the Agent gets
        // the hook's prompt even when the caller supplied an unrelated message;
        // the persisted Run intent remains the caller's original text.
        const providerInstructions = taskWorktree
          ? yield* fs.readFileString(join(taskWorktree, 'raws', '.folio-integration-instructions.md')).pipe(
              Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed(''))
            )
          : ''
        const agentPrompt = providerInstructions.trim() ? `${providerInstructions.trim()}\n\n${input.prompt}` : input.prompt
        yield* Effect.logInfo('Agent prompt dispatch', { taskId: input.taskId, sessionId: input.sessionId,
          runId: input.id, purpose: input.purpose, promptCharacters: agentPrompt.length })
        const pendingPrompt = session.prompt({ ...input, baselineCommit: baseline }, async () => {
          await Effect.runPromise(read(input.taskId, input.id).pipe(Effect.flatMap(value => Deferred.succeed(ready, value))))
        }, agentPrompt)
        prompt = pendingPrompt
        const idle = yield* Effect.tryPromise({ try: () => pendingPrompt, catch: safeError })
        if (!SessionUpdate.isStateUpdate(idle.update) || idle.update.state !== 'idle') return yield* failure('invalid-state')
        yield* sink.flush
        const tools = (yield* events.messages(input.sessionId)).filter(tool => tool.runId === input.id && tool.payload.kind === 'tool_call')
        // An idle event cannot finish known tools whose terminal status has not been persisted.
        if (tools.some(tool => !['completed', 'failed'].includes(String(tool.payload.data.status)))) return yield* failure('invalid-state')
        const reason = idle.update.stopReason
        yield* Effect.logInfo('Agent turn completed', { taskId: input.taskId, sessionId: input.sessionId,
          runId: input.id, stopReason: reason, toolCount: tools.length,
          failedToolCount: tools.filter(tool => tool.payload.data.status === 'failed').length })
        const outcome: RunOutcome = executionInterrupted(idle.update._meta) ? 'interrupted' : reason === 'end_turn' ? 'succeeded' : reason === 'cancelled'
          ? (entry.cancelled ? 'cancelled' : 'interrupted') : 'failed'
        return outcome
      })
      entry.lifetime = yield* execute.pipe(
        Effect.onExit(exit => Effect.gen(function*() {
          const outcome = Exit.isSuccess(exit) ? exit.value : entry.cancelled ? 'cancelled' : prompt ? 'interrupted' : 'failed'
          // Always reap the real processes, even if persisting the result fails.
          yield* sink.finishRun(input.id, outcome, Exit.isFailure(exit) ? 'Execution stopped before a confirmed terminal result.' : undefined).pipe(
            Effect.onExit(() => Effect.gen(function* () {
              if (opened) {
                yield* sessions.close(input.taskId, input.sessionId)
                if (prompt) yield* Effect.promise(() => prompt!.catch(() => undefined))
              }
            }))
          )
        })),
        Effect.catch(error => Deferred.fail(ready, safeError(error))),
        Effect.catchCause(() => Deferred.fail(ready, failure('storage'))),
        Effect.ensuring(Effect.gen(function*() {
          yield* Deferred.fail(ready, failure('invalid-state'))
          entries.delete(input.id)
        })),
        Effect.asVoid, Effect.interruptible, Effect.forkIn(owner)
      )
      entries.set(input.id, entry)
      return ready
    }, gate.withPermit, Effect.uninterruptible, Effect.mapError(safeError))

    /** Cancellation is owned by the app, so losing the RPC reply cannot interrupt cleanup. */
    const beginCancel = Effect.fn('HarnessRuns.beginCancel')(function*(taskId: string, runId: string) {
      const entry = entries.get(runId)
      if (!entry) {
        const run = yield* read(taskId, runId)
        if (run.state === 'preparing' || run.state === 'running') return yield* failure('invalid-state')
        return undefined
      }
      if (entry.input.taskId !== taskId) return yield* failure('not-found')
      entry.cancelled = true
      entry.cancelling ??= yield* Fiber.interrupt(entry.lifetime).pipe(Effect.forkIn(owner))
      return entry.cancelling
    }, gate.withPermit, Effect.uninterruptible)

    /** Explicit crash reconciliation never infers success or dispatches a recovery Prompt. */
    const inspect = Effect.fn('HarnessRuns.inspect')(function*(taskId: string, runId: string) {
      const run = yield* read(taskId, runId)
      if (run.state !== 'preparing' && run.state !== 'running') return run
      if (shuttingDown || [...entries.values()].some(entry => entry.input.taskId === taskId)) return yield* failure('task-busy')
      return yield* sessions.withStoppedSession(taskId, run.sessionId, history => Effect.gen(function*() {
        // Recheck under durable execution ownership; another process may have reconciled the ledger.
        const current = yield* read(taskId, runId)
        if (current.state === 'preparing' || current.state === 'running') {
          const saved = (yield* store.sessions(taskId)).find(session => session.id === run.sessionId)!
          if (history.length < (yield* events.lastSequence(run.sessionId))) return yield* failure('invalid-state')
          const connectionId = randomUUID()
          // The archive can be ahead of the UI at a crash. Existing associations are retained;
          // newly recovered events stay unassigned until an audited dispatch boundary proves their Run.
          for (const [index, update] of history.entries()) {
            const receipt = yield* Schema.decodeUnknownEffect(RecordedUpdate)({ sessionId: run.sessionId, runId: null, connectionId,
              notification: { sessionId: saved.acpSessionId!, update,
                _meta: { 'folio/eventSequence': index + 1 } } }).pipe(Effect.mapError(safeError))
            yield* sink.appendUpdate(receipt)
          }
          yield* sink.finishRun(runId, 'interrupted', 'Previous execution has stopped. Inspect saved progress before continuing.')
          yield* sink.flush
        }
        return yield* read(taskId, runId)
      }))
    }, gate.withPermit, Effect.uninterruptible)

    yield* Effect.addFinalizer(() => Effect.gen(function*() {
      shuttingDown = true
      // This layer is released before Sessions and SQL; Quit records interruption after cleanup.
      yield* Effect.forEach(entries.values(), entry => Fiber.interrupt(entry.lifetime), { concurrency: 'unbounded' })
    }))
    return HarnessRuns.of({
      inspect,
      // The Scheduler owns this wait. Interruption must stop and join the underlying process
      // before it can release a global slot. There is no separate immediate-start endpoint.
      execute: (input) => Effect.gen(function* () {
        const ready = yield* begin(input)
        const entry = entries.get(input.id)
        return yield* Effect.gen(function* () {
          yield* Deferred.await(ready)
          if (entry) yield* Fiber.join(entry.lifetime)
          yield* sink.flush
          return yield* read(input.taskId, input.id)
        }).pipe(Effect.ensuring(entry ? Fiber.interrupt(entry.lifetime) : Effect.void))
      }),
      cancel: (taskId, runId) => beginCancel(taskId, runId).pipe(
        Effect.flatMap(fiber => fiber ? Fiber.join(fiber) : Effect.void), Effect.andThen(read(taskId, runId)))
    })
  }))
}
