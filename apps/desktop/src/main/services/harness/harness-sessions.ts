import { AgentWorkerPool } from '../agent/agent-worker-pool'
import { openHarnessWorkerSession, type HarnessWorkerSessionOptions } from './harness-worker-session'
import { ExecutionEventSink } from '../execution/execution-event-sink'
import type { SessionUpdate } from '@agentclientprotocol/sdk/experimental/v2'
import { SessionArchive, SessionLeaseError, nativeAgent } from '@folio/agent'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Context, Deferred, Effect, Fiber, Layer, Scope, Semaphore } from 'effect'
import { ChildProcessSpawner } from 'effect/unstable/process'
import { HarnessStoreError, type SessionRecord, type TaskRecord } from '../../../shared/harness'
import { HarnessStore } from './harness-store'
import { HarnessEventStore } from './harness-event-store'

type Session = Omit<Effect.Success<ReturnType<typeof openHarnessWorkerSession>>, 'close'>
type RuntimeOptions = Omit<HarnessWorkerSessionOptions, 'taskId' | 'sessionId'>
interface Entry {
  readonly taskId: string
  readonly ready: Deferred.Deferred<Session, HarnessStoreError>
  readonly lifetime: Fiber.Fiber<void>
  closing?: Fiber.Fiber<void>
}
const failure = (reason: HarnessStoreError['reason']) => new HarnessStoreError({ reason,
  message: reason === 'task-busy' ? 'Close the current Task session before opening another.'
    : 'Could not open the Task session. Its saved history has been retained.' })

/**
 * Vault-owned live Session registry. Request scopes only wait for startup: their cancellation or
 * renderer destruction cannot dispose the Agent. This layer must live inside the application's
 * Vault resource layer, with the database outside it so finalizers can finish before SQL closes.
 */
export class HarnessSessions extends Context.Service<HarnessSessions, {
  /** Opens an existing Folio Session, joining concurrent startup. Never creates or sends a Run. */
  readonly open: (taskId: string, sessionId: string, claim?: { id: string; owner: string }) => Effect.Effect<Session, HarnessStoreError>
  /** Reports local process ownership so automatic cleanup never closes an inspection Session. */
  readonly hasLiveTask: (taskId: string) => Effect.Effect<boolean>
  /** Holds local and durable ownership while reconciling a stopped Session; never opens an Agent. */
  readonly withStoppedSession: <A>(taskId: string, sessionId: string, action: (history: readonly SessionUpdate[]) => Effect.Effect<A, HarnessStoreError>) => Effect.Effect<A, HarnessStoreError>
  /** Waits for cancellation and process cleanup before releasing this Task's live Session slot. */
  readonly close: (taskId: string, sessionId: string) => Effect.Effect<void, HarnessStoreError>
}>()('folio/services/HarnessSessions') {
  static layer(options: RuntimeOptions | Effect.Effect<RuntimeOptions, HarnessStoreError>, historyDirectory?: string,
    prepareResources?: (task: TaskRecord) => Effect.Effect<Pick<RuntimeOptions, 'skillPaths' | 'executableDirectories' | 'environment'>, HarnessStoreError>,
    resolveDirectory?: (task: TaskRecord, session: SessionRecord) => Effect.Effect<string, HarnessStoreError>) {
    return Layer.effect(HarnessSessions, Effect.gen(function*() {
      const owner = yield* Scope.Scope
      const store = yield* HarnessStore
      const dependencies = Context.make(HarnessStore, store).pipe(
        Context.add(HarnessEventStore, yield* HarnessEventStore),
        Context.add(AgentWorkerPool, yield* AgentWorkerPool),
        Context.add(ExecutionEventSink, yield* ExecutionEventSink),
        Context.add(ChildProcessSpawner.ChildProcessSpawner, yield* ChildProcessSpawner.ChildProcessSpawner)
      )
      const gate = yield* Semaphore.make(1)
      const entries = new Map<string, Entry>()
      let shuttingDown = false

      /** Only startup and ownership lookup are serialized; different Task processes initialize concurrently. */
      const acquire = Effect.fn('HarnessSessions.acquire')(function*(taskId: string, sessionId: string, claim?: { id: string; owner: string }) {
        if (shuttingDown) return yield* failure('invalid-state')
        const existing = entries.get(sessionId)
        if (existing) {
          if (existing.taskId !== taskId) return yield* failure('not-found')
          if (existing.closing) return yield* failure('task-busy')
          return existing.ready
        }
        const task = yield* store.task(taskId)
        const saved = (yield* store.sessions(taskId)).find(session => session.id === sessionId)
        if (!saved) return yield* failure('not-found')
        if (task.state !== 'active' || task.worktreeState !== 'ready') return yield* failure('invalid-state')
        if ([...entries.values()].some(entry => entry.taskId === taskId)
          || (yield* store.runs(taskId)).some(run => (run.state === 'preparing' || run.state === 'running')
            && !(run.id === claim?.id && run.owner === claim.owner && run.state === 'preparing' && run.baselineCommit === null))) {
          return yield* failure('task-busy')
        }
        const ready = yield* Deferred.make<Session, HarnessStoreError>()
        // The worker owns a private resource Scope and then stays alive until explicit close or Quit.
        // A failed startup remains in the registry until close; another request must not silently retry it.
        const lifetime = yield* Effect.gen(function*() {
          // Runtime discovery stays lazy so a missing bundle does not prevent browsing saved Tasks.
          const runtimeOptions = yield* Effect.isEffect(options) ? options : Effect.succeed(options)
          const resources = saved.purpose === 'task' && prepareResources ? yield* prepareResources(task) : {}
          const cwd = resolveDirectory
            ? yield* resolveDirectory(task, saved)
            : saved.purpose === 'task'
              ? task.worktree
              : yield* failure('invalid-state')
          const session = yield* openHarnessWorkerSession({ ...runtimeOptions, ...resources, taskId, sessionId, cwd })
          // Callers cannot close the private resource Scope without also releasing the registry slot.
          yield* Deferred.succeed(ready, { pid: session.pid, connectionId: session.connectionId,
            prompt: session.prompt, cancel: session.cancel })
          yield* Effect.never
        }).pipe(
          Effect.scoped,
          Effect.provide(dependencies),
          Effect.catch(error => Effect.logError('Agent Worker Session startup failed', { taskId, sessionId }, error).pipe(Effect.andThen(Deferred.fail(ready, error)))),
          Effect.onExit(() => Deferred.fail(ready, failure('invalid-state'))),
          Effect.asVoid,
          Effect.interruptible,
          Effect.forkIn(owner)
        )
        entries.set(sessionId, { taskId, ready, lifetime })
        return ready
      }, gate.withPermit, Effect.uninterruptible)

      /** Closing is also application-owned; losing its RPC reply cannot release the slot before cleanup. */
      const beginClose = Effect.fn('HarnessSessions.beginClose')(function*(taskId: string, sessionId: string) {
        const entry = entries.get(sessionId)
        if (!entry) return undefined
        if (entry.taskId !== taskId) return yield* failure('not-found')
        if (!entry.closing) {
          entry.closing = yield* Fiber.interrupt(entry.lifetime).pipe(
            Effect.andThen(Effect.sync(() => { entries.delete(sessionId) })),
            Effect.forkIn(owner)
          )
        }
        return entry.closing
      }, gate.withPermit, Effect.uninterruptible)

      /** Reads the registry under the same gate as acquire/close, including Sessions still closing. */
      const hasLiveTask = Effect.fn('HarnessSessions.hasLiveTask')(
        (taskId: string) => Effect.sync(() => [...entries.values()].some(entry => entry.taskId === taskId)),
        gate.withPermit
      )

      /** Both identity locks remain held through the ledger update, excluding cross-process resume. */
      const withStoppedSession = Effect.fn('HarnessSessions.withStoppedSession')(function*<A>(
        taskId: string, sessionId: string, action: (history: readonly SessionUpdate[]) => Effect.Effect<A, HarnessStoreError>
      ) {
        if (shuttingDown || [...entries.values()].some(entry => entry.taskId === taskId)) return yield* failure('task-busy')
        const task = yield* store.task(taskId)
        const saved = (yield* store.sessions(taskId)).find(session => session.id === sessionId)
        if (!saved?.acpSessionId || !saved.nativeSessionId) return yield* failure('invalid-state')
        // Main supplies this path separately so inspecting history never requires a working runtime bundle.
        const runtimeOptions = historyDirectory ? undefined : yield* Effect.isEffect(options) ? options : Effect.succeed(options)
        const directory = historyDirectory ?? runtimeOptions!.sessionStorageDirectory ?? runtimeOptions!.agentDirectory
        const archive = new SessionArchive(join(directory, 'acp-sessions'))
        const header = yield* Effect.tryPromise({ try: () => archive.readHeader(saved.acpSessionId!), catch: () => failure('storage') })
        const cwd = resolveDirectory
          ? yield* resolveDirectory(task, saved)
          : saved.purpose === 'task'
            ? task.worktree
            : yield* failure('invalid-state')
        if (header.cwd !== cwd || header.native.nativeSessionId !== saved.nativeSessionId
          || nativeAgent(header.native) !== saved.agent) return yield* failure('invalid-state')
        const lease = yield* Effect.tryPromise({
          try: () => archive.leases.acquire(saved.acpSessionId!, header.native, { requireExistingStore: true }),
          catch: error => error instanceof SessionLeaseError && error.reason === 'busy' ? failure('task-busy') : failure('storage')
        })
        // The whole operation is uninterruptible: a lost inspection reply must neither leak the
        // acquired lease nor release it before an in-flight database update has actually settled.
        return yield* Effect.gen(function*() {
          const checked = yield* Effect.tryPromise({ try: () => archive.read(saved.acpSessionId!), catch: () => failure('storage') })
          if (!isDeepStrictEqual(checked.header, header)) return yield* failure('invalid-state')
          return yield* action(checked.history)
        }).pipe(Effect.ensuring(Effect.promise(() => lease.release())))
      }, gate.withPermit, Effect.uninterruptible, Effect.catchDefect(() => Effect.fail(failure('storage'))))

      yield* Effect.addFinalizer(() => Effect.gen(function*() {
        shuttingDown = true
        yield* Effect.forEach(entries.values(), entry => Fiber.interrupt(entry.lifetime), { concurrency: 'unbounded' })
        entries.clear()
      }))
      return HarnessSessions.of({
        withStoppedSession,
        hasLiveTask,
        open: (taskId, sessionId, claim) => acquire(taskId, sessionId, claim).pipe(Effect.flatMap(Deferred.await)),
        close: (taskId, sessionId) => beginClose(taskId, sessionId).pipe(Effect.flatMap(fiber => fiber ? Fiber.join(fiber) : Effect.void))
      })
    }))
  }
}
