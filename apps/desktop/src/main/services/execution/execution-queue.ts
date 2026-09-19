import { Context, DateTime, Effect, Layer, Schema } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { RunRecord, ExecutionSubmission, emptyExecutionCounts, type ExecutionCounts } from '../../../shared/execution'
import { HarnessStoreError, RunOutcome } from '../../../shared/harness'

const failure = (reason: HarnessStoreError['reason']) => new HarnessStoreError({ reason,
  message: reason === 'not-found' ? 'Execution request was not found.' : 'Could not update the execution queue.' })
const safeError = (error: unknown) => error instanceof HarnessStoreError ? error : failure('storage')
const now = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis))
const Row = Schema.Struct({ ...RunRecord.fields, cancelRequested: Schema.Number })
const decode = Schema.decodeUnknownEffect(Schema.Array(Row))

/** Vault-owned durable inbox; only the global Scheduler may claim work and assign an owner. */
export class ExecutionQueue extends Context.Service<ExecutionQueue, {
  readonly counts: Effect.Effect<ExecutionCounts, HarnessStoreError>
  readonly submit: (input: ExecutionSubmission) => Effect.Effect<RunRecord, HarnessStoreError>
  readonly get: (id: string) => Effect.Effect<RunRecord, HarnessStoreError>
  readonly list: (taskId?: string) => Effect.Effect<readonly RunRecord[], HarnessStoreError>
  readonly claim: (owner: string) => Effect.Effect<RunRecord | null, HarnessStoreError>
  readonly running: (id: string, owner: string) => Effect.Effect<void, HarnessStoreError>
  readonly finish: (id: string, owner: string, outcome: RunOutcome, error?: string) => Effect.Effect<void, HarnessStoreError>
  readonly cancel: (id: string) => Effect.Effect<RunRecord, HarnessStoreError>
}>()('folio/services/ExecutionQueue') {
  static readonly layer = Layer.effect(ExecutionQueue, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const select = sql`SELECT sequence, id, task_id AS taskId, session_id AS sessionId, prompt, purpose,
      resumes_run_id AS resumesRunId, source, state, owner, cancel_requested AS cancelRequested,
      created_at AS createdAt, started_at AS startedAt, ended_at AS endedAt, error, baseline_commit AS baselineCommit, sync_state AS syncState FROM runs`
    const rows = (query: typeof select) => query.pipe(Effect.flatMap(decode),
      Effect.map(values => values.map(value => ({ ...value, cancelRequested: value.cancelRequested === 1 }))))
    const get = Effect.fn('ExecutionQueue.get')(function* (id: string) {
      const result = yield* rows(sql`${select} WHERE id=${id}`)
      if (!result[0]) return yield* failure('not-found')
      return result[0]
    }, Effect.mapError(safeError))
    const list = (taskId?: string) => rows(taskId === undefined
      ? sql`${select} ORDER BY sequence` : sql`${select} WHERE task_id=${taskId} ORDER BY sequence`).pipe(Effect.mapError(safeError))

    /** Compare immutable intent on retries; a reused ID must never silently change the prompt. */
    const submit = Effect.fn('ExecutionQueue.submit')(function* (input: ExecutionSubmission) {
      const value = yield* Schema.decodeUnknownEffect(ExecutionSubmission)(input)
      return yield* sql.withTransaction(Effect.gen(function* () {
        const previous = (yield* rows(sql`${select} WHERE id=${value.id}`))[0]
        if (previous) {
          if ((Object.keys(ExecutionSubmission.fields) as (keyof ExecutionSubmission)[]).some(key => previous[key] !== value[key])) return yield* failure('invalid-state')
          return previous
        }
        const session = (yield* sql<{ purpose: string; state: string }>`SELECT s.purpose, t.state
          FROM sessions s JOIN tasks t ON t.id=s.task_id WHERE s.id=${value.sessionId} AND s.task_id=${value.taskId}`)[0]
        if (!session || session.state !== 'active' || (session.purpose === 'conflict-resolution') !== (value.purpose === 'conflict-resolution')) {
          return yield* failure('invalid-state')
        }
        if (value.purpose === 'recovery') {
          if (!(yield* sql`SELECT id FROM runs WHERE id=${value.resumesRunId} AND task_id=${value.taskId}
            AND session_id=${value.sessionId} AND state IN ('failed', 'cancelled', 'interrupted')`).length) return yield* failure('invalid-state')
        } else if (value.resumesRunId !== null) return yield* failure('invalid-state')
        yield* sql`INSERT INTO runs (id, task_id, session_id, prompt, purpose, resumes_run_id, source, state, sync_state, created_at)
          VALUES (${value.id}, ${value.taskId}, ${value.sessionId}, ${value.prompt}, ${value.purpose}, ${value.resumesRunId}, ${value.source}, 'queued', 'not-required', ${yield* now})`
        return yield* get(value.id)
      }))
    }, Effect.mapError(safeError))

    /** One atomic claim skips busy Tasks, so their queued follow-ups cannot block other Tasks. */
    const claim = Effect.fn('ExecutionQueue.claim')(function* (owner: string) {
      if (!owner.trim()) return yield* failure('invalid-state')
      return yield* sql.withTransaction(Effect.gen(function* () {
        const changed = yield* sql<{ id: string }>`UPDATE runs SET state='preparing', owner=${owner}, started_at=${yield* now}
          WHERE id=(SELECT q.id FROM runs q JOIN tasks t ON t.id=q.task_id
            WHERE q.state='queued' AND t.state='active'
            AND NOT EXISTS (SELECT 1 FROM git_change_applications a JOIN git_change_preparations p ON p.id=a.id
              WHERE p.task_id=q.task_id AND a.state='applying')
            AND (q.purpose='conflict-resolution' OR NOT EXISTS (
              SELECT 1 FROM git_sync_operations pending WHERE pending.task_id=q.task_id
                AND pending.state NOT IN ('aligned', 'aborted') AND (pending.state<>'superseded' OR NOT EXISTS (
                  SELECT 1 FROM git_sync_operations replacement WHERE replacement.supersedes_id=pending.id))))
            AND NOT EXISTS (SELECT 1 FROM runs active WHERE active.task_id=q.task_id AND active.state IN ('preparing', 'running'))
            ORDER BY q.sequence LIMIT 1) AND state='queued' RETURNING id`
        return changed[0] ? yield* get(changed[0].id) : null
      }))
    }, Effect.mapError(safeError))
    const running = Effect.fn('ExecutionQueue.running')(function* (id: string, owner: string) {
      if (!(yield* sql`UPDATE runs SET state='running' WHERE id=${id} AND owner=${owner} AND state='preparing' AND baseline_commit IS NOT NULL RETURNING id`).length) {
        return yield* failure('invalid-state')
      }
    }, Effect.mapError(safeError))
    /** Owner fencing rejects late completion from an obsolete worker. Call only after process cleanup. */
    const finish = Effect.fn('ExecutionQueue.finish')(function* (id: string, owner: string, outcome: RunOutcome, error?: string) {
      yield* Schema.decodeUnknownEffect(RunOutcome)(outcome)
      if (!(yield* sql`UPDATE runs SET state=${outcome}, ended_at=${yield* now}, error=${error ?? null}
        WHERE id=${id} AND owner=${owner} AND state IN ('preparing', 'running') RETURNING id`).length) return yield* failure('invalid-state')
    }, Effect.mapError(safeError))
    /** Running cancellation is an intent; it does not release ownership before the worker stops. */
    const cancel = Effect.fn('ExecutionQueue.cancel')(function* (id: string) {
      return yield* sql.withTransaction(Effect.gen(function* () {
        yield* sql`UPDATE runs SET cancel_requested=1,
          ended_at=CASE WHEN state='queued' THEN ${yield* now} ELSE ended_at END,
          state=CASE WHEN state='queued' THEN 'cancelled' ELSE state END
          WHERE id=${id} AND state IN ('queued', 'preparing', 'running')`
        return yield* get(id)
      }))
    }, Effect.mapError(safeError))
    return ExecutionQueue.of({
      counts: sql<{ state: keyof ExecutionCounts; count: number }>`SELECT state, COUNT(*) AS count FROM runs GROUP BY state`.pipe(
        Effect.map(rows => {
          const counts = emptyExecutionCounts()
          for (const row of rows) counts[row.state] = row.count
          return counts
        }), Effect.mapError(safeError)),
      submit, get, list, claim, running, finish, cancel
    })
  }))
}
