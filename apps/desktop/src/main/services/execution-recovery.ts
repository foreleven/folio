import type { AgentWorkerPool } from './agent-worker-pool'
import { Effect } from 'effect'
import type { SqlClient } from 'effect/unstable/sql'
import type { ExecutionQueue } from './execution-queue'
import type { ExecutionEventSink } from './execution-event-sink'
import type { HarnessStore } from './harness-store'
import type { HarnessRuns } from './harness-runs'
import type { HarnessSessions } from './harness-sessions'

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
  readonly sql: SqlClient.SqlClient
}) {
  return Effect.gen(function* () {
    yield* deps.sink.flush
    for (const request of yield* deps.queue.list()) {
      if (request.state === 'queued' || request.endedAt !== null || deps.owned.has(request.id)) continue
      yield* Effect.gen(function* () {
        const workers = yield* deps.sql<{ owner_pid: number; thread_id: number; stopped: number }>`SELECT owner_pid, thread_id, stopped FROM execution_workers WHERE request_id=${request.id}`
        const worker = workers[0]
        if (worker && !worker.stopped) {
          if (worker.owner_pid === process.pid) {
            if (deps.workers.hasThread(worker.thread_id)) return
            yield* Effect.tryPromise({ try: () => deps.workers.reconcile(worker.thread_id), catch: error => error })
          } else if (hasExecutionProcess(worker.owner_pid)) return
        }
        const processes = yield* deps.sql<{ pid: number; stopped: number }>`SELECT pid, stopped FROM execution_processes WHERE request_id=${request.id}`
        if (processes.some(native => !native.stopped && hasExecutionProcess(native.pid))) return
        for (const native of processes) if (!native.stopped) yield* deps.sink.processStopped(request.sessionId, native.pid)
        if (worker && !worker.stopped) yield* deps.sink.workerStopped(request.sessionId)
        let run = (yield* deps.store.runs(request.taskId)).find(value => value.id === request.id)
        const session = (yield* deps.store.sessions(request.taskId)).find(value => value.id === request.sessionId)
        if (yield* deps.sessions.hasLiveTask(request.taskId)) return
        if (run && (run.state === 'preparing' || run.state === 'running')) {
          run = yield* deps.runs.inspect(request.taskId, request.id)
        } else if (!run && session?.acpSessionId && session.nativeSessionId) {
          yield* deps.sessions.withStoppedSession(request.taskId, request.sessionId, () => Effect.void)
        }
        // Without process-started, the Worker could not yet send initialize/session.new.
        // The request still becomes interrupted rather than silently replaying its prompt.
        const outcome = run && run.state !== 'preparing' && run.state !== 'running' ? run.state : 'interrupted'
        yield* deps.sink.finishRequest(request, outcome, outcome === 'interrupted'
          ? 'Previous execution stopped. Inspect saved progress before submitting a new request.' : undefined)
      }).pipe(Effect.catch(() => Effect.logWarning('An execution still requires stopped-process or archive reconciliation.')))
    }
  })
}
