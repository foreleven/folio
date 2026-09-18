import { Context, DateTime, Effect, Layer, Schema } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { HarnessStoreError } from '../../shared/harness'
import { RoutineExecution, RoutineRecord, SaveRoutine, previousRoutineDate, routineDateAt, routineDayEnd } from '../../shared/routine'
import { TaskWorktrees } from './task-worktrees'
import { SessionModelSelection } from '../../shared/model'

const now = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis))
const safe = (error: unknown) =>
  error instanceof HarnessStoreError
    ? error
    : new HarnessStoreError({ reason: 'storage', message: error instanceof Error && error.message ? error.message : 'Could not save Routine state.' })
const fail = (reason: HarnessStoreError['reason'], message?: string) =>
  new HarnessStoreError({
    reason,
    message: message ?? (reason === 'not-found' ? 'Routine was not found.' : reason === 'invalid-state' ? 'Routine has changed or is not ready.' : 'Could not save Routine state.')
  })

const DbRoutine = Schema.Struct({
  id: RoutineRecord.fields.id,
  name: RoutineRecord.fields.name,
  prompt: RoutineRecord.fields.prompt,
  agent: RoutineRecord.fields.agent,
  modelProviderId: Schema.NullOr(Schema.String),
  modelId: Schema.NullOr(Schema.String),
  thinkingLevel: Schema.NullOr(SessionModelSelection.fields.thinkingLevel),
  skillIds: Schema.fromJsonString(Schema.Array(Schema.NonEmptyString)),
  integrationIds: Schema.fromJsonString(Schema.Array(Schema.NonEmptyString)),
  resourceIds: Schema.fromJsonString(Schema.Array(Schema.NonEmptyString)),
  intervalMinutes: RoutineRecord.fields.intervalMinutes,
  timeZone: RoutineRecord.fields.timeZone,
  enabled: Schema.Union([Schema.Boolean, Schema.Number]),
  revision: RoutineRecord.fields.revision,
  nextTriggerAt: RoutineRecord.fields.nextTriggerAt,
  lastTriggerAt: RoutineRecord.fields.lastTriggerAt,
  createdAt: RoutineRecord.fields.createdAt,
  updatedAt: RoutineRecord.fields.updatedAt
})
const DbExecution = Schema.Struct({
  routineId: RoutineExecution.fields.routineId,
  taskId: RoutineExecution.fields.taskId,
  routineDate: RoutineExecution.fields.routineDate,
  triggerTime: RoutineExecution.fields.triggerTime,
  firstTriggerTime: RoutineExecution.fields.firstTriggerTime,
  triggerCount: RoutineExecution.fields.triggerCount,
  isEnd: Schema.Union([Schema.Boolean, Schema.Number]),
  windowStart: RoutineExecution.fields.windowStart,
  windowEnd: RoutineExecution.fields.windowEnd,
  model: Schema.NullOr(Schema.fromJsonString(SessionModelSelection)),
  timeZone: RoutineExecution.fields.timeZone,
  routineRevision: RoutineExecution.fields.routineRevision,
  status: RoutineExecution.fields.status,
  startedAt: RoutineExecution.fields.startedAt,
  endedAt: RoutineExecution.fields.endedAt,
  createdAt: RoutineExecution.fields.createdAt,
  updatedAt: RoutineExecution.fields.updatedAt
})

function decodeRoutine(row: typeof DbRoutine.Type): RoutineRecord {
  const model = row.modelProviderId && row.modelId && row.thinkingLevel ? { providerId: row.modelProviderId, modelId: row.modelId, thinkingLevel: row.thinkingLevel } : null
  const { modelProviderId: _provider, modelId: _model, thinkingLevel: _thinking, ...record } = row
  return { ...record, enabled: row.enabled === true || row.enabled === 1, model }
}

function decodeExecution(row: typeof DbExecution.Type): RoutineExecution {
  return { ...row, isEnd: row.isEnd === true || row.isEnd === 1 }
}

/** Owns Routine configuration and scheduling metadata on Tasks. Execution receipts remain in runs. */
export class RoutineStore extends Context.Service<
  RoutineStore,
  {
    readonly list: Effect.Effect<readonly RoutineRecord[], HarnessStoreError>
    readonly get: (id: string) => Effect.Effect<RoutineRecord, HarnessStoreError>
    readonly save: (input: SaveRoutine) => Effect.Effect<RoutineRecord, HarnessStoreError>
    readonly schedule: (routineId: string, at?: number) => Effect.Effect<RoutineExecution, HarnessStoreError>
    readonly allExecutions: Effect.Effect<readonly RoutineExecution[], HarnessStoreError>
    readonly executions: (routineId: string) => Effect.Effect<readonly RoutineExecution[], HarnessStoreError>
    readonly executionForTask: (taskId: string) => Effect.Effect<RoutineExecution | null, HarnessStoreError>
  }
>()('folio/services/RoutineStore') {
  static readonly layer = Layer.effect(
    RoutineStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const worktrees = yield* TaskWorktrees
      const decodeRoutines = Schema.decodeUnknownEffect(Schema.Array(DbRoutine))
      const decodeExecutions = (input: unknown) => Schema.decodeUnknownEffect(Schema.Array(DbExecution))(input).pipe(Effect.map((rows) => rows.map(decodeExecution)))

      const readRoutines = sql`SELECT id, name, prompt, agent, model_provider_id AS modelProviderId, model_id AS modelId,
      thinking_level AS thinkingLevel, skill_ids AS skillIds, integration_ids AS integrationIds, resource_ids AS resourceIds,
      interval_minutes AS intervalMinutes, time_zone AS timeZone, enabled, revision,
      next_trigger_at AS nextTriggerAt, last_trigger_at AS lastTriggerAt, created_at AS createdAt, updated_at AS updatedAt
      FROM routines ORDER BY created_at DESC, id`.pipe(
        Effect.flatMap(decodeRoutines),
        Effect.map((rows) => rows.map(decodeRoutine)),
        Effect.mapError(safe)
      )

      // A Routine execution is a read projection of its Task and latest normal request.
      // Resolution requests must not overwrite the outcome of the Routine's actual work.
      const readExecutionRows = (routineId?: string, taskId?: string) =>
        sql`SELECT t.routine_id AS routineId, t.id AS taskId, t.routine_date AS routineDate,
          t.trigger_time AS triggerTime, t.first_trigger_time AS firstTriggerTime, t.trigger_count AS triggerCount,
          t.is_end AS isEnd, t.window_start AS windowStart, t.window_end AS windowEnd,
          t.routine_model AS model, t.routine_time_zone AS timeZone,
          t.routine_revision AS routineRevision,
          CASE WHEN t.state='cancelled' THEN 'cancelled'
            WHEN r.state='queued' THEN 'pending' ELSE COALESCE(r.state, 'pending') END AS status,
          r.started_at AS startedAt, r.ended_at AS endedAt, t.created_at AS createdAt,
          MAX(t.routine_updated_at, COALESCE(r.ended_at, r.started_at, r.created_at, 0)) AS updatedAt
          FROM tasks t LEFT JOIN runs r ON r.sequence=(
            SELECT MAX(sequence) FROM runs WHERE task_id=t.id AND purpose<>'conflict-resolution')
          WHERE t.routine_id IS NOT NULL
            AND (${routineId ?? null} IS NULL OR t.routine_id=${routineId ?? null})
            AND (${taskId ?? null} IS NULL OR t.id=${taskId ?? null})
          ORDER BY t.routine_date DESC, t.trigger_time DESC, t.id`
          .pipe(Effect.flatMap(decodeExecutions), Effect.mapError(safe))

      const list = readRoutines
      const get = Effect.fn('RoutineStore.get')(function* (id: string) {
        const row = (yield* sql`SELECT id, name, prompt, agent, model_provider_id AS modelProviderId, model_id AS modelId,
        thinking_level AS thinkingLevel, skill_ids AS skillIds, integration_ids AS integrationIds, resource_ids AS resourceIds,
        interval_minutes AS intervalMinutes, time_zone AS timeZone, enabled, revision,
        next_trigger_at AS nextTriggerAt, last_trigger_at AS lastTriggerAt, created_at AS createdAt, updated_at AS updatedAt
        FROM routines WHERE id=${id}`.pipe(Effect.flatMap(decodeRoutines))).at(0)
        return row ? decodeRoutine(row) : yield* fail('not-found')
      }, Effect.mapError(safe))

      const save = Effect.fn('RoutineStore.save')(function* (input: SaveRoutine) {
        const value = yield* Schema.decodeUnknownEffect(SaveRoutine)(input, { onExcessProperty: 'error' })
        if ((value.agent === 'pi') !== (value.model !== null)) return yield* fail('invalid-state', 'Pi requires a model selection and Codex uses local configuration.')
        const skillIds = [...new Set(value.skillIds)].sort()
        const integrationIds = [...new Set(value.integrationIds)].sort()
        const resourceIds = [...new Set(value.resourceIds ?? [])].sort()
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const previous = yield* get(value.id).pipe(Effect.catchTag('HarnessStoreError', (error) => (error.reason === 'not-found' ? Effect.succeed(null) : Effect.fail(error))))
            const revision = (value.expectedRevision ?? 0) + 1
            if (
              previous &&
              previous.revision === revision &&
              isDeepStrictEqual({ ...value, skillIds, integrationIds, resourceIds }, {
                  id: previous.id,
                  expectedRevision: value.expectedRevision,
                  name: previous.name,
                  prompt: previous.prompt,
                  agent: previous.agent,
                  model: previous.model,
                  skillIds: previous.skillIds,
                  integrationIds: previous.integrationIds,
                  resourceIds: previous.resourceIds,
                  intervalMinutes: previous.intervalMinutes,
                  timeZone: previous.timeZone,
                  enabled: previous.enabled
                })
            )
              return previous
            if (previous ? previous.revision !== value.expectedRevision : value.expectedRevision !== null) return yield* fail('invalid-state')
            const time = yield* now
            const modelProviderId = value.model?.providerId ?? null
            const modelId = value.model?.modelId ?? null
            const thinkingLevel = value.model?.thinkingLevel ?? null
            if (previous) {
              yield* sql`UPDATE routines SET name=${value.name}, prompt=${value.prompt}, agent=${value.agent},
            model_provider_id=${modelProviderId}, model_id=${modelId}, thinking_level=${thinkingLevel},
            skill_ids=${JSON.stringify(skillIds)}, integration_ids=${JSON.stringify(integrationIds)}, resource_ids=${JSON.stringify(resourceIds)},
            interval_minutes=${value.intervalMinutes}, time_zone=${value.timeZone}, enabled=${value.enabled ? 1 : 0},
            revision=${revision}, updated_at=${time} WHERE id=${value.id} AND revision=${value.expectedRevision}`
            } else {
              yield* sql`INSERT INTO routines (id, name, prompt, agent, model_provider_id, model_id, thinking_level,
            skill_ids, integration_ids, resource_ids, interval_minutes, time_zone, enabled, revision, next_trigger_at, last_trigger_at, created_at, updated_at)
            VALUES (${value.id}, ${value.name}, ${value.prompt}, ${value.agent}, ${modelProviderId}, ${modelId}, ${thinkingLevel},
              ${JSON.stringify(skillIds)}, ${JSON.stringify(integrationIds)}, ${JSON.stringify(resourceIds)}, ${value.intervalMinutes}, ${value.timeZone}, ${value.enabled ? 1 : 0}, 1, NULL, NULL, ${time}, ${time})`
            }
            return yield* get(value.id)
          })
        )
      }, Effect.mapError(safe))

      const executionRows = (routineId: string) => readExecutionRows(routineId)
      const allExecutions = readExecutionRows()
      const executions = Effect.fn('RoutineStore.executions')((routineId: string) => executionRows(routineId))
      const executionForTask = Effect.fn('RoutineStore.executionForTask')(function* (taskId: string) {
        return (yield* readExecutionRows(undefined, taskId)).at(0) ?? null
      }, Effect.mapError(safe))

      const schedule = Effect.fn('RoutineStore.schedule')(function* (routineId: string, at = Date.now()) {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const routine = yield* get(routineId)
            if (!routine.enabled) return yield* fail('invalid-state', 'Routine is paused.')
            // Each execution is a bounded ingestion window. The first run covers one
            // configured interval; later runs begin at the previous trigger. A
            // pending execution keeps its original start while its end is coalesced.
            const today = routineDateAt(at, routine.timeZone)
            const previousDate = previousRoutineDate(today, routine.timeZone)
            const candidates = yield* executionRows(routineId)
            // Dispatch wall time can be later than a day-end window. Continue from
            // the last reserved data boundary so midnight-to-dispatch data is not lost.
            const windowStartFor = (end: number) => Math.min(end, Math.max(routine.createdAt,
              candidates[0]?.windowEnd ?? routine.lastTriggerAt ?? end - routine.intervalMinutes * 60_000))
            const defaultWindowStart = windowStartFor(at)
            // An admitted prompt is immutable. Coalescing its time window would make the UI
            // describe different work from the queued request and could enqueue a second Task.
            const admitted = (yield* sql<{ taskId: string }>`SELECT r.task_id AS taskId FROM runs r
              JOIN tasks t ON t.id=r.task_id WHERE t.routine_id=${routineId}
                AND r.state IN ('queued', 'preparing', 'running') ORDER BY r.sequence LIMIT 1`)[0]
            if (admitted) {
              yield* sql`UPDATE routines SET next_trigger_at=${at + routine.intervalMinutes * 60_000} WHERE id=${routineId}`
              return candidates.find(candidate => candidate.taskId === admitted.taskId)!
            }
            const pending =
              candidates.find((execution) => execution.status === 'pending') ?? candidates.find((execution) => ['failed', 'interrupted', 'cancelled'].includes(execution.status))
            const time = yield* now
            if (pending) {
              // Editing the Routine does not reinterpret an already reserved civil day.
              const pendingToday = routineDateAt(at, pending.timeZone)
              const pendingPreviousDate = previousRoutineDate(pendingToday, pending.timeZone)
              // A day-end remains bounded to its civil day, even after repeated failures.
              if (pending.isEnd) {
                yield* sql`UPDATE routines SET next_trigger_at=${at + routine.intervalMinutes * 60_000} WHERE id=${routineId}`
                return pending
              }
              if (pending.routineDate === pendingToday && !pending.isEnd) {
                yield* sql`UPDATE tasks SET trigger_time=${at}, window_end=${at}, trigger_count=trigger_count+1,
              window_start=COALESCE(window_start, ${defaultWindowStart}), routine_updated_at=${time} WHERE id=${pending.taskId}`
              } else if (pending.routineDate === pendingPreviousDate && !pending.isEnd) {
                const end = routineDayEnd(pendingPreviousDate, pending.timeZone)
                yield* sql`UPDATE tasks SET trigger_time=${end}, window_end=${end}, is_end=1,
              window_start=COALESCE(window_start, ${defaultWindowStart}), trigger_count=trigger_count+1, routine_updated_at=${time} WHERE id=${pending.taskId}`
              } else {
                // A missed execution is still one logical window: later ticks update its
                // latest trigger rather than creating a queue of catch-up rows. We only
                // mark the previous civil day as ended when this is the first tick of the
                // following day; older gaps remain visible in the derived calendar.
                yield* sql`UPDATE tasks SET trigger_time=${at}, window_end=${at},
              window_start=COALESCE(window_start, ${defaultWindowStart}), trigger_count=trigger_count+1, routine_updated_at=${time} WHERE id=${pending.taskId}`
              }
              yield* sql`UPDATE routines SET next_trigger_at=${at + routine.intervalMinutes * 60_000}, last_trigger_at=${at}, updated_at=${time} WHERE id=${routineId}`
              return (yield* executionRows(routineId)).find((execution) => execution.taskId === pending.taskId)!
            }
            const previousEnd = candidates.some(execution =>
              execution.routineDate === previousDate && execution.isEnd && execution.status === 'succeeded')
            const unresolvedEnd = (yield* executionRows(routineId)).find(
              (execution) => execution.routineDate === previousDate && execution.isEnd && execution.status !== 'succeeded'
            )
            // A failed/interrupted day-end keeps its identity for an explicit retry; the
            // unique end index forbids creating a second end row for the same date.
            if (unresolvedEnd) return unresolvedEnd
            const createdDate = routineDateAt(routine.createdAt, routine.timeZone)
            const date = !previousEnd && createdDate < today ? previousDate : today
            const isEnd = date === previousDate && !previousEnd
            const triggerTime = isEnd ? routineDayEnd(date, routine.timeZone) : at
            const taskId = randomUUID()
            // Reserve the normal Task and its window in the same transaction. No orphan
            // execution or second identity can survive a failed reservation.
            yield* worktrees.reserve({ id: taskId, goal: routine.prompt, configuration: {
              agent: routine.agent, skillIds: [],
              integrationIds: routine.integrationIds, resourceIds: routine.resourceIds ?? []
            } })
            yield* sql`UPDATE tasks SET routine_id=${routineId}, routine_date=${date}, trigger_time=${triggerTime},
              first_trigger_time=${triggerTime}, trigger_count=1, is_end=${isEnd ? 1 : 0},
              window_start=${windowStartFor(triggerTime)}, window_end=${triggerTime}, routine_revision=${routine.revision},
              routine_model=${routine.model ? JSON.stringify(routine.model) : null}, routine_time_zone=${routine.timeZone},
              routine_updated_at=${time} WHERE id=${taskId}`
            yield* sql`UPDATE routines SET next_trigger_at=${at + routine.intervalMinutes * 60_000}, last_trigger_at=${at}, updated_at=${time} WHERE id=${routineId}`
            return (yield* readExecutionRows(routineId, taskId))[0]!
          })
        )
      }, Effect.mapError(safe))

      return RoutineStore.of({ list, get, save, schedule, allExecutions, executions, executionForTask })
    })
  )
}
