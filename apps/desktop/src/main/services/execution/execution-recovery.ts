import type { AgentWorkerPool } from '../agent/agent-worker-pool'
import { Effect } from 'effect'
import { processIdentity } from './process-identity'
import { fileEffect, RUN_INSTANCE_ID, type RunFileStore } from './run-files'
import type { ExecutionQueue } from './execution-queue'
import type { ExecutionEventSink } from './execution-event-sink'
import type { HarnessStore } from '../harness/harness-store'
import type { HarnessRuns } from '../harness/harness-runs'
import type { HarnessSessions } from '../harness/harness-sessions'

/** Permission failures and reused PIDs are conservatively treated as live ownership. */
export function hasExecutionProcess(pid: number): boolean {
  const exists = (target: number) => {
    try { process.kill(target, 0); return true }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
  }
  return exists(pid) || (process.platform !== 'win32' && exists(-pid))
}

/**
 * Replays receipts before inspecting abandoned ownership. Never submits a prompt. Native leases
 * and archive reconciliation are reused from the existing Harness instead of guessing success.
 */
export function recoverExecutions(deps: {
  readonly workers: AgentWorkerPool['Service']
  readonly owned: ReadonlySet<string>
  readonly queue: ExecutionQueue['Service']
  readonly sink: ExecutionEventSink['Service']
  readonly store: HarnessStore['Service']
  readonly runs: HarnessRuns['Service']
  readonly sessions: HarnessSessions['Service']
  readonly files: RunFileStore
}) {
  return Effect.gen(function* () {
    const states = yield* fileEffect(() => deps.files.list())
    const requests = yield* deps.queue.list()
    // Include terminal/orphan file entries: a committed terminal receipt may precede file removal.
    for (const state of states) {
      const request = requests.find(value => value.id === state.runId && value.owner === state.owner)
      if (!request) return yield* Effect.fail(new Error('Unowned execution recovery file requires inspection'))
      if (deps.owned.has(request.id)) continue
      yield* Effect.gen(function* () {
        const retain = (reason: string) => Effect.promise(() => deps.files.log(state, 'recovery', { decision: reason }))
        if (!state.workerStopped) {
          if (state.ownerPid === process.pid && state.instanceId === RUN_INSTANCE_ID && state.threadId !== null) {
            if (deps.workers.hasThread(state.threadId)) return yield* retain('live-worker')
            yield* Effect.tryPromise({ try: () => deps.workers.reconcile(state.threadId!), catch: error => error })
          } else if (hasExecutionProcess(state.ownerPid)) {
            const identity = yield* Effect.promise(() => processIdentity(state.ownerPid))
            if (!identity || !state.ownerIdentity || identity.started === state.ownerIdentity.started) return yield* retain('live-or-unknown-owner')
          }
          // The spawn/registration window needs native lease inspection, never an assumed exit.
          if (state.threadId === null && state.phase === 'starting') return yield* retain('startup-identity-unconfirmed')
        }
        for (const native of state.processes) {
          if (native.stopped || !hasExecutionProcess(native.pid)) continue
          const identity = yield* Effect.promise(() => processIdentity(native.pid))
          if (!identity || !native.identity || identity.started === native.identity.started) return yield* retain('live-or-unknown-process')
          // A reused leader PID does not prove that its old tool process group exited.
          if (process.platform !== 'win32') {
            const groupAlive = yield* Effect.sync(() => {
              try { process.kill(-native.identity!.group, 0); return true }
              catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
            })
            if (groupAlive) return yield* retain('live-process-group')
          }
        }
        if (yield* deps.sessions.hasLiveTask(request.taskId)) return yield* retain('live-session')
        yield* Effect.promise(() => deps.files.log(state, 'recovery', { decision: 'processes-stopped' }))
        if (state.binding) yield* deps.store.bindSession(request.sessionId, state.binding)
        const session = (yield* deps.store.sessions(request.taskId)).find(value => value.id === request.sessionId)
        if (session?.acpSessionId && session.nativeSessionId) {
          yield* deps.sessions.withStoppedSession(request.taskId, request.sessionId, () => Effect.void)
        }
        yield* fileEffect(() => deps.files.update(request.id, state.owner, current => ({ ...current,
          workerStopped: true, processes: current.processes.map(native => ({ ...native, stopped: true })), phase: 'cleaning' })))
        if (request.endedAt !== null) {
          yield* fileEffect(() => deps.files.remove(request.id, state.owner))
          return
        }
        if (!state.result && session?.acpSessionId && session.nativeSessionId) yield* deps.runs.inspect(request.taskId, request.id)
        yield* deps.sink.finishRequest(request, 'interrupted', 'Previous execution stopped. Inspect saved progress before submitting a new request.')
      }).pipe(Effect.catch(() => Effect.logWarning('An execution still requires stopped-process or archive reconciliation.')))
    }
    yield* Effect.promise(() => deps.files.prune(new Set(requests.filter(run => run.endedAt !== null).map(run => run.id))))
    // A missing receipt after claim cannot prove that no Agent was launched. Keep its
    // durable ownership visible instead of automatically dispatching the same prompt.
    for (const request of requests) {
      if (request.state === 'queued' || request.endedAt !== null || deps.owned.has(request.id)) continue
      if (!states.some(state => state.runId === request.id && state.owner === request.owner)) {
        yield* Effect.logWarning('Execution recovery file is missing; ownership is retained', { runId: request.id })
      }
    }
  })
}
