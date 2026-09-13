import { Context, DateTime, Effect, Layer, Schema } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { randomUUID } from 'node:crypto'
import { HarnessStoreError } from '../../shared/harness'
import { RoutineExecution, RoutineRecord, SaveRoutine, previousRoutineDate, routineDateAt, routineDayEnd } from '../../shared/routine'
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
  id: RoutineExecution.fields.id,
  routineId: RoutineExecution.fields.routineId,
  taskId: RoutineExecution.fields.taskId,
  routineDate: RoutineExecution.fields.routineDate,
  triggerTime: RoutineExecution.fields.triggerTime,
  firstTriggerTime: RoutineExecution.fields.firstTriggerTime,
  triggerCount: RoutineExecution.fields.triggerCount,
  isEnd: Schema.Union([Schema.Boolean, Schema.Number]),
  windowStart: RoutineExecution.fields.windowStart,
  windowEnd: RoutineExecution.fields.windowEnd,
  routineRevision: RoutineExecution.fields.routineRevision,
  status: RoutineExecution.fields.status,
  startedAt: RoutineExecution.fields.startedAt,
  endedAt: RoutineExecution.fields.endedAt,
  createdAt: RoutineExecution.fields.createdAt,
  updatedAt: RoutineExecution.fields.updatedAt
})

function decodeRoutine(row: typeof DbRoutine.Type): RoutineRecord {
  const model = row.modelProviderId && row.modelId && row.thinkingLevel ? { providerId: row.modelProviderId, modelId: row.modelId, thinkingLevel: row.thinkingLevel } : null
  return { ...row, enabled: row.enabled === true || row.enabled === 1, model }
}

function decodeExecution(row: typeof DbExecution.Type): RoutineExecution {
  return { ...row, isEnd: row.isEnd === true || row.isEnd === 1 }
}

/** Owns flat Routine configuration and the single coalescing execution ledger. */
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
    readonly attachTask: (executionId: string, taskId: string) => Effect.Effect<RoutineExecution, HarnessStoreError>
    readonly setStatus: (taskId: string, status: RoutineExecution['status'], startedAt?: number, endedAt?: number) => Effect.Effect<void, HarnessStoreError>
  }
>()('folio/services/RoutineStore') {
  static readonly layer = Layer.effect(
    RoutineStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
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

      const readExecutionRows = (routineId?: string) =>
        (routineId
          ? sql`SELECT id, routine_id AS routineId, task_id AS taskId, routine_date AS routineDate, trigger_time AS triggerTime,
          first_trigger_time AS firstTriggerTime, trigger_count AS triggerCount, is_end AS isEnd,
          window_start AS windowStart, window_end AS windowEnd, routine_revision AS routineRevision, status,
          started_at AS startedAt, ended_at AS endedAt, created_at AS createdAt, updated_at AS updatedAt
          FROM routine_executions WHERE routine_id=${routineId} ORDER BY routine_date DESC, trigger_time DESC, id`
          : sql`SELECT id, routine_id AS routineId, task_id AS taskId, routine_date AS routineDate, trigger_time AS triggerTime,
          first_trigger_time AS firstTriggerTime, trigger_count AS triggerCount, is_end AS isEnd,
          window_start AS windowStart, window_end AS windowEnd, routine_revision AS routineRevision, status,
          started_at AS startedAt, ended_at AS endedAt, created_at AS createdAt, updated_at AS updatedAt
          FROM routine_executions ORDER BY routine_date DESC, trigger_time DESC, id`
        ).pipe(Effect.flatMap(decodeExecutions), Effect.mapError(safe))

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
              JSON.stringify({ ...value, skillIds, integrationIds, resourceIds }) ===
                JSON.stringify({
                  id: previous.id,
                  expectedRevision: previous.revision - 1,
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
        return (
          (yield* sql`SELECT id, routine_id AS routineId, task_id AS taskId, routine_date AS routineDate, trigger_time AS triggerTime,
        first_trigger_time AS firstTriggerTime, trigger_count AS triggerCount, is_end AS isEnd, window_start AS windowStart,
        window_end AS windowEnd, routine_revision AS routineRevision, status, started_at AS startedAt, ended_at AS endedAt,
        created_at AS createdAt, updated_at AS updatedAt FROM routine_executions WHERE task_id=${taskId}`.pipe(Effect.flatMap(decodeExecutions))).at(0) ?? null
        )
      }, Effect.mapError(safe))

      const schedule = Effect.fn('RoutineStore.schedule')(function* (routineId: string, at = Date.now()) {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const routine = yield* get(routineId)
            if (!routine.enabled) return yield* fail('invalid-state', 'Routine is paused.')
            // Each execution is a bounded ingestion window. The first run covers one
            // configured interval; later runs begin at the previous trigger. A
            // pending execution keeps its original start while its end is coalesced.
            const defaultWindowStart = Math.min(at, Math.max(routine.createdAt, routine.lastTriggerAt ?? at - routine.intervalMinutes * 60_000))
            const today = routineDateAt(at, routine.timeZone)
            const previousDate = previousRoutineDate(today, routine.timeZone)
            const candidates = yield* executionRows(routineId)
            const pending =
              candidates.find((execution) => execution.status === 'pending') ?? candidates.find((execution) => ['failed', 'interrupted', 'cancelled'].includes(execution.status))
            const time = yield* now
            if (pending) {
              if (pending.routineDate === today && !pending.isEnd) {
                yield* sql`UPDATE routine_executions SET trigger_time=${at}, window_end=${at}, trigger_count=trigger_count+1,
              window_start=COALESCE(window_start, ${defaultWindowStart}), status='pending', started_at=NULL, ended_at=NULL, updated_at=${time} WHERE id=${pending.id} AND status IN ('pending', 'failed', 'interrupted', 'cancelled')`
              } else if (pending.routineDate === previousDate && !pending.isEnd) {
                const end = routineDayEnd(previousDate, routine.timeZone)
                yield* sql`UPDATE routine_executions SET trigger_time=${end}, window_end=${end}, is_end=1,
              window_start=COALESCE(window_start, ${defaultWindowStart}), trigger_count=trigger_count+1, status='pending', started_at=NULL, ended_at=NULL, updated_at=${time} WHERE id=${pending.id} AND status IN ('pending', 'failed', 'interrupted', 'cancelled')`
              } else {
                // A missed execution is still one logical window: later ticks update its
                // latest trigger rather than creating a queue of catch-up rows. We only
                // mark the previous civil day as ended when this is the first tick of the
                // following day; older gaps remain visible in the derived calendar.
                yield* sql`UPDATE routine_executions SET trigger_time=${at}, window_end=${at},
              window_start=COALESCE(window_start, ${defaultWindowStart}), trigger_count=trigger_count+1, status='pending', started_at=NULL, ended_at=NULL, updated_at=${time} WHERE id=${pending.id} AND status IN ('pending', 'failed', 'interrupted', 'cancelled')`
              }
              yield* sql`UPDATE routines SET next_trigger_at=${at + routine.intervalMinutes * 60_000}, last_trigger_at=${at}, updated_at=${time} WHERE id=${routineId}`
              return (yield* executionRows(routineId)).find((execution) => execution.id === pending.id)!
            }
            const previousEnd =
              (yield* sql`SELECT id FROM routine_executions WHERE routine_id=${routineId} AND routine_date=${previousDate}
          AND is_end=1 AND status='succeeded' LIMIT 1`).length > 0
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
            const execution = {
              id: randomUUID(),
              routineId,
              taskId: null,
              routineDate: date,
              triggerTime,
              firstTriggerTime: triggerTime,
              triggerCount: 1,
              isEnd,
              windowStart: defaultWindowStart,
              windowEnd: triggerTime,
              routineRevision: routine.revision,
              status: 'pending' as const,
              startedAt: null,
              endedAt: null,
              createdAt: time,
              updatedAt: time
            }
            yield* sql`INSERT INTO routine_executions (id, routine_id, task_id, routine_date, trigger_time, first_trigger_time,
          trigger_count, is_end, window_start, window_end, routine_revision, status, started_at, ended_at, created_at, updated_at)
          VALUES (${execution.id}, ${routineId}, NULL, ${date}, ${triggerTime}, ${triggerTime}, 1, ${isEnd ? 1 : 0}, ${defaultWindowStart},
            ${triggerTime}, ${routine.revision}, 'pending', NULL, NULL, ${time}, ${time})`
            yield* sql`UPDATE routines SET next_trigger_at=${at + routine.intervalMinutes * 60_000}, last_trigger_at=${at}, updated_at=${time} WHERE id=${routineId}`
            return execution
          })
        )
      }, Effect.mapError(safe))

      const attachTask = Effect.fn('RoutineStore.attachTask')(function* (executionId: string, taskId: string) {
        const changed = yield* sql`UPDATE routine_executions SET task_id=${taskId}, updated_at=${yield* now}
        WHERE id=${executionId} AND (task_id IS NULL OR task_id=${taskId}) RETURNING id`
        if (!changed.length) return yield* fail('invalid-state', 'Execution is already attached to another Task.')
        const row = (yield* sql`SELECT id, routine_id AS routineId, task_id AS taskId, routine_date AS routineDate, trigger_time AS triggerTime,
        first_trigger_time AS firstTriggerTime, trigger_count AS triggerCount, is_end AS isEnd, window_start AS windowStart,
        window_end AS windowEnd, routine_revision AS routineRevision, status, started_at AS startedAt, ended_at AS endedAt,
        created_at AS createdAt, updated_at AS updatedAt FROM routine_executions WHERE id=${executionId}`.pipe(Effect.flatMap(decodeExecutions))).at(0)
        if (!row) return yield* fail('not-found')
        return row
      }, Effect.mapError(safe))

      const setStatus = Effect.fn('RoutineStore.setStatus')(function* (taskId: string, status: RoutineExecution['status'], startedAt?: number, endedAt?: number) {
        yield* Schema.decodeUnknownEffect(RoutineExecution.fields.status)(status)
        const timestamp = yield* now
        const terminal = ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(status)
        const changed = yield* sql`UPDATE routine_executions SET status=${status},
        started_at=COALESCE(${startedAt ?? null}, started_at),
        ended_at=COALESCE(${endedAt ?? (terminal ? timestamp : null)}, ended_at),
        updated_at=${timestamp} WHERE task_id=${taskId} RETURNING id`
        if (!changed.length) return yield* fail('not-found', 'Routine execution was not found for this Task.')
      }, Effect.mapError(safe))

      return RoutineStore.of({ list, get, save, schedule, allExecutions, executions, executionForTask, attachTask, setStatus })
    })
  )
}
