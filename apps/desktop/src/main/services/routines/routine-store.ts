import { Context, DateTime, Effect, Layer, Schema } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { AgentTaskConfiguration, HarnessStoreError, type IngestionReceipt } from '../../../shared/harness'
import {
  AgentRoutineConfiguration,
  IngestionRoutineConfiguration,
  RoutineExecution,
  RoutineExecutionStatus,
  RoutineRecord,
  ScheduleTrigger,
  SaveRoutine,
  routineDateAt,
  routineDayStart
} from '../../../shared/routine'
import { TaskWorktrees } from '../tasks/task-worktrees'

const now = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis))
const safe = (error: unknown) => error instanceof HarnessStoreError
  ? error
  : new HarnessStoreError({ reason: 'storage', message: error instanceof Error && error.message ? error.message : 'Could not save Routine state.' })
const fail = (reason: HarnessStoreError['reason'], message?: string) => new HarnessStoreError({
  reason,
  message: message ?? (reason === 'not-found' ? 'Routine was not found.' : reason === 'invalid-state' ? 'Routine has changed or is not ready.' : 'Could not save Routine state.')
})

const RoutineRowCommon = {
  id: Schema.String, name: Schema.String, trigger: Schema.fromJsonString(ScheduleTrigger),
  enabled: Schema.Union([Schema.Boolean, Schema.Number]), revision: Schema.Int,
  nextTriggerAt: Schema.NullOr(Schema.Number), lastTriggerAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number, updatedAt: Schema.Number
}
const DbRoutine = Schema.Union([
  Schema.Struct({ ...RoutineRowCommon, type: Schema.Literal('agent'), configuration: Schema.fromJsonString(AgentRoutineConfiguration) }),
  Schema.Struct({ ...RoutineRowCommon, type: Schema.Literal('ingestion'), configuration: Schema.fromJsonString(IngestionRoutineConfiguration) })
])
const DbExecution = Schema.Struct({
  routineId: Schema.String, taskId: Schema.String, type: Schema.Literals(['agent', 'ingestion']),
  runId: Schema.NullOr(Schema.String), cancelRequested: Schema.Union([Schema.Boolean, Schema.Number]),
  triggerTime: Schema.Number,
  windowStart: Schema.Number, windowEnd: Schema.Number,
  model: Schema.NullOr(Schema.fromJsonString(AgentTaskConfiguration.fields.model)),
  timeZone: Schema.String, routineRevision: Schema.Int, status: RoutineExecutionStatus,
  startedAt: Schema.NullOr(Schema.Number), endedAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number, updatedAt: Schema.Number
})

function decodeRoutine(row: typeof DbRoutine.Type): RoutineRecord {
  return { ...row, enabled: row.enabled === true || row.enabled === 1 }
}
function decodeExecution(row: typeof DbExecution.Type): RoutineExecution {
  return { ...row, routineDate: routineDateAt(row.windowStart, row.timeZone), cancelRequested: row.cancelRequested === true || row.cancelRequested === 1 }
}
const initialIngestionReceipt = (): IngestionReceipt => ({
  state: 'pending', attemptCount: 0, cancelRequested: false,
  startedAt: null, endedAt: null, error: null, changeId: null, observedHead: null
})

/** Owns typed Routine definitions and projects Agent Run or Ingestion Task receipts uniformly. */
export class RoutineStore extends Context.Service<RoutineStore, {
  readonly list: Effect.Effect<readonly RoutineRecord[], HarnessStoreError>
  readonly get: (id: string) => Effect.Effect<RoutineRecord, HarnessStoreError>
  readonly save: (input: SaveRoutine) => Effect.Effect<RoutineRecord, HarnessStoreError>
  readonly schedule: (routineId: string, at?: number, mode?: 'check' | 'settled') => Effect.Effect<RoutineExecution | null, HarnessStoreError>
  readonly allExecutions: Effect.Effect<readonly RoutineExecution[], HarnessStoreError>
  readonly executions: (routineId: string) => Effect.Effect<readonly RoutineExecution[], HarnessStoreError>
  readonly executionForTask: (taskId: string) => Effect.Effect<RoutineExecution | null, HarnessStoreError>
}>()('folio/services/RoutineStore') {
  static readonly layer = Layer.effect(RoutineStore, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const worktrees = yield* TaskWorktrees
    const decodeRoutines = Schema.decodeUnknownEffect(Schema.Array(DbRoutine))
    const decodeExecutions = (input: unknown) => Schema.decodeUnknownEffect(Schema.Array(DbExecution))(input).pipe(Effect.map(rows => rows.map(decodeExecution)))

    const readRoutines = sql`SELECT id, name, type, configuration,
      trigger, enabled, revision,
      next_trigger_at AS nextTriggerAt, last_trigger_at AS lastTriggerAt,
      created_at AS createdAt, updated_at AS updatedAt
      FROM routines ORDER BY created_at DESC, id`.pipe(
      Effect.flatMap(decodeRoutines), Effect.map(rows => rows.map(decodeRoutine)), Effect.mapError(safe)
    )

    const readExecutionRows = (routineId?: string, taskId?: string) =>
      sql`SELECT s.routine_id AS routineId, t.id AS taskId, t.type,
        CASE WHEN t.type='agent' THEN r.id ELSE NULL END AS runId,
        CASE WHEN t.type='agent' THEN COALESCE(r.cancel_requested, 0)
          ELSE COALESCE(json_extract(t.receipt, '$.cancelRequested'), 0) END AS cancelRequested,
        s.trigger_time AS triggerTime,
        s.window_start AS windowStart, s.window_end AS windowEnd,
        CASE WHEN t.type='agent' THEN json_extract(t.configuration, '$.model') ELSE NULL END AS model,
        s.time_zone AS timeZone, t.routine_revision AS routineRevision,
        CASE WHEN t.type='ingestion' THEN json_extract(t.receipt, '$.state')
          WHEN t.state='cancelled' THEN 'cancelled'
          WHEN r.state='queued' THEN 'pending' ELSE COALESCE(r.state, 'pending') END AS status,
        CASE WHEN t.type='ingestion' THEN json_extract(t.receipt, '$.startedAt') ELSE r.started_at END AS startedAt,
        CASE WHEN t.type='ingestion' THEN json_extract(t.receipt, '$.endedAt') ELSE r.ended_at END AS endedAt,
        t.created_at AS createdAt,
        MAX(s.created_at,
          COALESCE(CASE WHEN t.type='ingestion' THEN json_extract(t.receipt, '$.endedAt') ELSE r.ended_at END,
            CASE WHEN t.type='ingestion' THEN json_extract(t.receipt, '$.startedAt') ELSE r.started_at END,
            s.created_at)) AS updatedAt
        FROM routine_schedules s JOIN tasks t ON t.id=s.task_id LEFT JOIN runs r ON t.type='agent' AND r.sequence=(
          SELECT MAX(sequence) FROM runs WHERE task_id=t.id AND purpose<>'conflict-resolution')
        WHERE (${routineId ?? null} IS NULL OR s.routine_id=${routineId ?? null})
          AND (${taskId ?? null} IS NULL OR t.id=${taskId ?? null})
        ORDER BY s.window_start DESC, s.trigger_time DESC, t.id`.pipe(Effect.flatMap(decodeExecutions), Effect.mapError(safe))

    const get = Effect.fn('RoutineStore.get')(function* (id: string) {
      const rows = yield* sql`SELECT id, name, type, configuration,
        trigger, enabled, revision,
        next_trigger_at AS nextTriggerAt, last_trigger_at AS lastTriggerAt,
        created_at AS createdAt, updated_at AS updatedAt FROM routines WHERE id=${id}`.pipe(Effect.flatMap(decodeRoutines))
      return rows[0] ? decodeRoutine(rows[0]) : yield* fail('not-found')
    }, Effect.mapError(safe))

    const save = Effect.fn('RoutineStore.save')(function* (input: SaveRoutine) {
      const value = yield* Schema.decodeUnknownEffect(SaveRoutine)(input, { onExcessProperty: 'error' })
      if (value.type === 'agent' && ((value.configuration.agent === 'pi') !== (value.configuration.model !== null))) {
        return yield* fail('invalid-state', 'Pi requires a model selection and Codex uses local configuration.')
      }
      const normalized = value.type === 'agent'
        ? { ...value, configuration: {
            ...value.configuration,
            skillIds: [...new Set(value.configuration.skillIds)].sort(),
            integrationIds: [...new Set(value.configuration.integrationIds)].sort(),
            resourceIds: [...new Set(value.configuration.resourceIds)].sort()
          } }
        : value
      return yield* sql.withTransaction(Effect.gen(function* () {
        const previous = yield* get(value.id).pipe(Effect.catchTag('HarnessStoreError', error => error.reason === 'not-found' ? Effect.succeed(null) : Effect.fail(error)))
        const revision = (value.expectedRevision ?? 0) + 1
        if (previous && previous.revision === revision && isDeepStrictEqual(normalized, {
          id: previous.id, expectedRevision: value.expectedRevision, name: previous.name,
          type: previous.type, configuration: previous.configuration,
          trigger: previous.trigger, enabled: previous.enabled
        })) return previous
        if (previous ? previous.revision !== value.expectedRevision : value.expectedRevision !== null) return yield* fail('invalid-state')
        if (value.type === 'ingestion') {
          const occupied = yield* sql<{ id: string }>`SELECT id FROM routines WHERE type='ingestion'
            AND json_extract(configuration, '$.integrationId')=${value.configuration.integrationId}
            AND json_extract(configuration, '$.resourceId')=${value.configuration.resourceId}
            AND id<>${value.id} LIMIT 1`
          if (occupied.length) return yield* fail('invalid-state', 'This Integration resource already has an Ingestion Routine.')
        }
        const time = yield* now
        if (previous) {
          yield* sql`UPDATE routines SET name=${normalized.name}, type=${normalized.type}, configuration=${JSON.stringify(normalized.configuration)},
            trigger=${JSON.stringify(normalized.trigger)}, enabled=${normalized.enabled ? 1 : 0},
            revision=${revision}, updated_at=${time} WHERE id=${normalized.id} AND revision=${normalized.expectedRevision}`
        } else {
          yield* sql`INSERT INTO routines (id, name, type, configuration, trigger, enabled,
            revision, next_trigger_at, last_trigger_at, created_at, updated_at)
            VALUES (${normalized.id}, ${normalized.name}, ${normalized.type}, ${JSON.stringify(normalized.configuration)},
              ${JSON.stringify(normalized.trigger)}, ${normalized.enabled ? 1 : 0}, 1, NULL, NULL, ${time}, ${time})`
        }
        return yield* get(normalized.id)
      }))
    }, Effect.mapError(safe))

    const executions = Effect.fn('RoutineStore.executions')((routineId: string) => readExecutionRows(routineId))
    const executionForTask = Effect.fn('RoutineStore.executionForTask')(function* (taskId: string) {
      return (yield* readExecutionRows(undefined, taskId))[0] ?? null
    }, Effect.mapError(safe))

    const schedule = Effect.fn('RoutineStore.schedule')(function* (routineId: string, at = Date.now(), mode: 'check' | 'settled' = 'check') {
      return yield* sql.withTransaction(Effect.gen(function* () {
        const routine = yield* get(routineId)
        if (!routine.enabled) return yield* fail('invalid-state', 'Routine is paused.')
        const candidates = yield* readExecutionRows(routineId)
        const today = routineDateAt(at, routine.trigger.timeZone)
        const todayStart = routineDayStart(today, routine.trigger.timeZone)
        const time = yield* now
        if (mode === 'check') {
          yield* sql`UPDATE routines SET next_trigger_at=${at + routine.trigger.intervalMinutes * 60_000},
            last_trigger_at=${at}, updated_at=${time} WHERE id=${routineId}`
        }
        const admitted = candidates.find(row => row.status === 'preparing' || row.status === 'running')
        if (admitted) return mode === 'check' ? admitted : null
        // Cancelled/conflicted Ingestion is an explicit manual-repair state. It retains the
        // frozen Task/window and must block a duplicate reservation on scheduler checks.
        const manualIngestionRepair = candidates.find(row => row.routineDate === today && row.type === 'ingestion'
          && (row.status === 'cancelled' || row.status === 'conflict'))
        if (manualIngestionRepair) return null
        const currentRetry = [...candidates.filter(row => row.routineDate === today)]
          .filter(row => row.status === 'pending' || row.status === 'failed' || row.status === 'interrupted' ||
            row.type === 'agent' && row.status === 'cancelled' && !row.cancelRequested)
          .sort((a, b) => b.windowEnd - a.windowEnd)[0]
        if (currentRetry) return mode === 'check' ? currentRetry : null
        const latest = [...candidates]
          .filter(row => row.status === 'succeeded' || row.type === 'agent' && row.status === 'cancelled' && row.cancelRequested)
          .sort((a, b) => b.windowEnd - a.windowEnd)[0]
        const boundary = Math.max(todayStart, latest?.windowEnd ?? todayStart)
        const delta = at - boundary
        if (delta <= 0) return null
        if (mode === 'settled') {
          if (!latest) return null
          const threshold = latest.type === 'agent' && latest.status === 'cancelled' ? routine.trigger.intervalMinutes * 60_000 : 3_600_000
          if (delta < threshold) return null
        }
        const taskId = randomUUID()
        if (routine.type === 'agent') {
          yield* worktrees.reserve({ id: taskId, type: 'agent', receipt: null, configuration: {
            goal: routine.configuration.goal, agent: routine.configuration.agent, model: routine.configuration.model,
            skillIds: routine.configuration.skillIds, integrationIds: routine.configuration.integrationIds,
            resourceIds: routine.configuration.resourceIds
          } })
        } else {
          yield* worktrees.reserve({ id: taskId, type: 'ingestion', receipt: initialIngestionReceipt(), configuration: routine.configuration })
        }
        const windowStart = boundary
        const windowEnd = Math.min(at, windowStart + 3_600_000)
        yield* sql`UPDATE tasks SET routine_id=${routineId}, routine_revision=${routine.revision} WHERE id=${taskId}`
        yield* sql`INSERT INTO routine_schedules (task_id, routine_id, trigger_time, window_start, window_end, time_zone, created_at)
          VALUES (${taskId}, ${routineId}, ${at}, ${windowStart}, ${windowEnd}, ${routine.trigger.timeZone}, ${time})`
        yield* sql`UPDATE routines SET next_trigger_at=${at + routine.trigger.intervalMinutes * 60_000},
          last_trigger_at=${at}, updated_at=${time} WHERE id=${routineId}`
        return (yield* readExecutionRows(routineId, taskId))[0]!
      }))
    }, Effect.mapError(safe))

    return RoutineStore.of({ list: readRoutines, get, save, schedule, allExecutions: readExecutionRows(), executions, executionForTask })
  }))
}
