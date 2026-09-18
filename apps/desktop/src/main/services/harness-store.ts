import { ModelProfile } from '@folio/agent/config/schema'
import { Context, DateTime, Effect, Layer, Schema } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { HarnessStoreError, NewRun, NewSession, NewTask, RunRecord, SessionBinding, SessionRecord, TaskConfiguration, TaskRecord } from '../../shared/harness'

const TaskRow = Schema.Struct({ ...TaskRecord.fields, configuration: Schema.fromJsonString(TaskConfiguration) })
const SessionRow = Schema.Struct({ ...SessionRecord.fields, modelProfile: Schema.NullOr(Schema.fromJsonString(ModelProfile)) })
const now = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis))
const failure = (reason: HarnessStoreError['reason']) =>
  new HarnessStoreError({
    reason,
    message:
      reason === 'routine-busy'
        ? 'Another Task from this Routine is running or awaiting synchronization.'
        : reason === 'task-busy'
          ? 'This task already has an active run.'
          : reason === 'not-found'
            ? 'Execution record was not found.'
            : reason === 'invalid-state'
              ? 'This execution transition is not allowed.'
              : 'Could not read or save execution records.'
  })
const storageError = (cause: unknown) => (cause instanceof HarnessStoreError ? cause : failure('storage'))

/**
 * Vault-scoped execution ledger. Methods persist intent and transitions only; they never send
 * a Prompt, touch Git, infer process death, or convert a successful Run into a completed Task.
 */
export class HarnessStore extends Context.Service<
  HarnessStore,
  {
    readonly createTask: (input: NewTask) => Effect.Effect<void, HarnessStoreError>
    readonly task: (id: string) => Effect.Effect<TaskRecord, HarnessStoreError>
    readonly tasks: Effect.Effect<readonly TaskRecord[], HarnessStoreError>
    readonly createSession: (input: NewSession) => Effect.Effect<void, HarnessStoreError>
    readonly bindSession: (id: string, binding: SessionBinding) => Effect.Effect<void, HarnessStoreError>
    readonly sessions: (taskId: string) => Effect.Effect<readonly SessionRecord[], HarnessStoreError>
    readonly reserveRun: (input: NewRun, claimOwner: string) => Effect.Effect<void, HarnessStoreError>
    readonly runs: (taskId: string) => Effect.Effect<readonly RunRecord[], HarnessStoreError>
  }
>()('folio/services/HarnessStore') {
  static readonly layer = Layer.effect(
    HarnessStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      /** Creates a stable manual Task snapshot; resource creation is the caller's separate responsibility. */
      const createTask = Effect.fn('HarnessStore.createTask')(function* (input: NewTask) {
        const value = yield* Schema.decodeUnknownEffect(NewTask)(input)
        yield* sql`INSERT INTO tasks (id, goal, configuration, branch, worktree, state, created_at)
        VALUES (${value.id}, ${value.goal}, ${JSON.stringify(value.configuration)}, ${value.branch}, ${value.worktree}, 'active', ${yield* now})`
      }, Effect.mapError(storageError))

      /** Reads this Vault's immutable snapshot and independent Task lifecycle. */
      const tasks = sql`SELECT id, goal, configuration, branch, worktree, state,
      worktree_state AS worktreeState, worktree_base AS worktreeBase, created_at AS createdAt
      FROM tasks ORDER BY created_at DESC, id DESC`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(TaskRow))), Effect.mapError(storageError))

      /** Retrieves one Task, distinguishing missing identity from a storage failure. */
      const task = Effect.fn('HarnessStore.task')(function* (id: string) {
        const rows = yield* sql`SELECT id, goal, configuration, branch, worktree, state,
        worktree_state AS worktreeState, worktree_base AS worktreeBase, created_at AS createdAt FROM tasks WHERE id=${id}`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(TaskRow)))
        )
        if (!rows[0]) return yield* failure('not-found')
        return rows[0]
      }, Effect.mapError(storageError))

      /** Allocates a Folio identity before ACP creation; every Session inherits its Task's fixed Agent. */
      const createSession = Effect.fn('HarnessStore.createSession')(function* (input: NewSession) {
        const value = yield* Schema.decodeUnknownEffect(NewSession)(input)
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const owner = yield* task(value.taskId)
            if (owner.state !== 'active') return yield* failure('invalid-state')
            const active = yield* sql`SELECT id FROM runs WHERE task_id=${value.taskId} AND state IN ('preparing', 'running')`
            if (active.length) return yield* failure('task-busy')
            if (value.purpose === 'task' &&
              (yield* sql`SELECT pending.id FROM git_sync_operations pending WHERE pending.task_id=${value.taskId} AND pending.state NOT IN ('aligned', 'aborted')
              AND (pending.state<>'superseded' OR NOT EXISTS (
                SELECT 1 FROM git_sync_operations replacement WHERE replacement.supersedes_id=pending.id))`).length
            ) {
              return yield* failure('task-busy')
            }
            if (value.purpose === 'conflict-resolution' && !(yield* sql`SELECT id FROM git_sync_operations
              WHERE id=${value.syncOperationId} AND task_id=${value.taskId} AND state IN ('conflict', 'resolving')`).length) {
              return yield* failure('invalid-state')
            }
            yield* sql`INSERT INTO sessions
              (id, task_id, agent, adapter_version, purpose, sync_operation_id, model_profile, created_at)
          VALUES (${value.id}, ${value.taskId}, ${value.agent}, ${value.adapterVersion}, ${value.purpose},
            ${value.syncOperationId}, ${value.modelProfile ? JSON.stringify(value.modelProfile) : null}, ${yield* now})`
          })
        )
      }, Effect.mapError(storageError))

      /** Binds independently supplied protocol/native IDs once. Unknown native identity remains null. */
      const bindSession = Effect.fn('HarnessStore.bindSession')(function* (id: string, input: SessionBinding) {
        const binding = yield* Schema.decodeUnknownEffect(SessionBinding)(input)
        const changed = yield* sql`UPDATE sessions SET acp_session_id=${binding.acpSessionId}, native_session_id=${binding.nativeSessionId}
        WHERE id=${id} AND ((acp_session_id IS NULL AND native_session_id IS NULL)
          OR (acp_session_id=${binding.acpSessionId} AND native_session_id IS ${binding.nativeSessionId})) RETURNING id`
        if (!changed.length) return yield* failure('invalid-state')
      }, Effect.mapError(storageError))

      /** Lists independent Session identities without collapsing multiple conversations for one Task. */
      const sessions = Effect.fn('HarnessStore.sessions')(
        (taskId: string) =>
          sql`SELECT id, task_id AS taskId, agent, adapter_version AS adapterVersion, purpose,
        sync_operation_id AS syncOperationId, acp_session_id AS acpSessionId,
        native_session_id AS nativeSessionId, model_profile AS modelProfile, created_at AS createdAt FROM sessions WHERE task_id=${taskId} ORDER BY created_at, id`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SessionRow)))
          ),
        Effect.mapError(storageError)
      )

      /** Lists Runs by their durable insertion sequence; wall clocks and caller UUIDs are not causal ordering. */
      const runs = Effect.fn('HarnessStore.runs')(
        (taskId: string) =>
          sql`SELECT id, task_id AS taskId, session_id AS sessionId, prompt, purpose, resumes_run_id AS resumesRunId,
        baseline_commit AS baselineCommit, state, sync_state AS syncState, sequence, source, owner, cancel_requested AS cancelRequested,
        started_at AS startedAt, created_at AS createdAt, ended_at AS endedAt, error
        FROM runs WHERE task_id=${taskId} ORDER BY sequence`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ ...RunRecord.fields, cancelRequested: Schema.Number })))), Effect.map(rows => rows.map(row => ({ ...row, cancelRequested: row.cancelRequested === 1 })))),
        Effect.mapError(storageError)
      )

      /** Verifies Git and Session readiness before filling the baseline of the already-claimed Run. */
      const reserveRun = Effect.fn('HarnessStore.reserveRun')(function* (input: NewRun, claimOwner: string) {
        const value = yield* Schema.decodeUnknownEffect(NewRun)(input)
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const owner = yield* task(value.taskId)
            if (owner.state !== 'active' || owner.worktreeState !== 'ready') return yield* failure('invalid-state')
            const saving = yield* sql`SELECT a.id FROM git_change_applications a JOIN git_change_preparations p ON p.id=a.id
          WHERE p.task_id=${value.taskId} AND a.state='applying'`
            if (saving.length) return yield* failure('task-busy')
            // Keep the stable service error for normal callers; database triggers independently
            // enforce the same invariant for writers that bypass this ledger method.
            const session = (yield* sql<{ purpose: 'task' | 'conflict-resolution'; syncOperationId: string | null }>`SELECT
              purpose, sync_operation_id AS syncOperationId FROM sessions
              WHERE id=${value.sessionId} AND task_id=${value.taskId} AND acp_session_id IS NOT NULL`)[0]
            if (!session) return yield* failure('invalid-state')
            if (value.purpose === 'conflict-resolution') {
              if (session.purpose !== 'conflict-resolution' || !session.syncOperationId ||
                !(yield* sql`SELECT id FROM git_sync_operations WHERE id=${session.syncOperationId}
                  AND task_id=${value.taskId} AND state IN ('conflict', 'resolving')`).length) {
                return yield* failure('invalid-state')
              }
            } else {
              if (session.purpose !== 'task') return yield* failure('invalid-state')
              if (
                (yield* sql`SELECT pending.id FROM git_sync_operations pending WHERE pending.task_id=${value.taskId} AND pending.state NOT IN ('aligned', 'aborted')
                AND (pending.state<>'superseded' OR NOT EXISTS (
                  SELECT 1 FROM git_sync_operations replacement WHERE replacement.supersedes_id=pending.id))`).length
              ) {
                return yield* failure('task-busy')
              }
            }
            const active = yield* sql`SELECT id FROM runs WHERE task_id=${value.taskId} AND id<>${value.id} AND state IN ('preparing', 'running')`
            if (active.length) return yield* failure('task-busy')
            if (value.purpose === 'recovery') {
              const previous = yield* sql`SELECT id FROM runs WHERE id=${value.resumesRunId} AND task_id=${value.taskId}
            AND session_id=${value.sessionId} AND state IN ('failed', 'interrupted', 'cancelled')`
              if (!previous.length) {
                return yield* failure('invalid-state')
              }
            } else if (value.resumesRunId !== null) return yield* failure('invalid-state')
            const changed = yield* sql`UPDATE runs SET baseline_commit=${value.baselineCommit},
              sync_state=${value.purpose === 'conflict-resolution' ? 'not-required' : 'pending'}
              WHERE id=${value.id} AND task_id=${value.taskId} AND session_id=${value.sessionId}
                AND prompt=${value.prompt} AND purpose=${value.purpose} AND resumes_run_id IS ${value.resumesRunId}
                AND owner=${claimOwner} AND state='preparing' AND (baseline_commit IS NULL OR baseline_commit=${value.baselineCommit}) RETURNING id`
            if (!changed.length) return yield* failure('invalid-state')
          })
        )
      }, Effect.mapError(storageError))

      return HarnessStore.of({ createTask, task, tasks, createSession, bindSession, sessions, reserveRun, runs })
    })
  )
}
