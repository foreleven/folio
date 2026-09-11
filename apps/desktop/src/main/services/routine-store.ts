import { Context, DateTime, Effect, Layer, Schema } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { randomUUID } from 'node:crypto'
import { DailyTime, nextDailyOccurrence, VaultTimeZone } from '../../shared/routine-schedule'
import { HarnessStoreError } from '../../shared/harness'
import { EnqueueRoutine, RoutineDefinition, RoutineExecution, RoutineRecord, RoutineTrigger, RoutineWakeup, SaveRoutine, TriggerRoutine } from '../../shared/routine'

const RecordRow = Schema.Struct({ ...RoutineRecord.fields, definition: Schema.fromJsonString(RoutineDefinition) })
const TriggerRow = Schema.Struct({ ...RoutineTrigger.fields, snapshot: Schema.fromJsonString(RoutineRecord) })
const now = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis))
const fail = (reason: HarnessStoreError['reason']) => new HarnessStoreError({ reason,
  message: reason === 'not-found' ? 'Routine was not found.' : reason === 'invalid-state'
    ? 'Routine has changed, is paused, or this identity already belongs to another operation.' : 'Could not save Routine state.' })
const safe = (error: unknown) => error instanceof HarnessStoreError ? error : fail('storage')

/** Vault-local definitions and accepted trigger snapshots. No Integration, Git or Agent side effects occur here. */
export class RoutineStore extends Context.Service<RoutineStore, {
  readonly list: Effect.Effect<readonly RoutineRecord[], HarnessStoreError>
  readonly save: (input: SaveRoutine) => Effect.Effect<RoutineRecord, HarnessStoreError>
  readonly claim: (input: TriggerRoutine) => Effect.Effect<RoutineTrigger, HarnessStoreError>
  readonly prepareExecution: (triggerId: string) => Effect.Effect<RoutineExecution, HarnessStoreError>
  readonly triggers: (routineId: string) => Effect.Effect<readonly RoutineTrigger[], HarnessStoreError>
  readonly forTask: (taskId: string) => Effect.Effect<RoutineTrigger | null, HarnessStoreError>
  readonly enqueue: (input: EnqueueRoutine) => Effect.Effect<RoutineWakeup, HarnessStoreError>
  readonly wakeups: (routineId: string) => Effect.Effect<readonly RoutineWakeup[], HarnessStoreError>
  readonly claimPending: (routineId: string) => Effect.Effect<RoutineTrigger | null, HarnessStoreError>
}>()('folio/services/RoutineStore') {
  static readonly layer = Layer.effect(RoutineStore, Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const records = Schema.decodeUnknownEffect(Schema.Array(RecordRow))
    const triggers = Schema.decodeUnknownEffect(Schema.Array(TriggerRow))
    const wakeupRows = Schema.decodeUnknownEffect(Schema.Array(RoutineWakeup))
    const list = sql`SELECT id, definition, revision, created_at AS createdAt, updated_at AS updatedAt
      FROM routines ORDER BY created_at DESC, id`.pipe(Effect.flatMap(records), Effect.mapError(safe))

    /** Compare-and-swap edits protect concurrent windows; an exact lost-reply retry is read-only. */
    const save = Effect.fn('RoutineStore.save')(function*(input: SaveRoutine) {
      const value = yield* Schema.decodeUnknownEffect(SaveRoutine)(input, { onExcessProperty: 'error' })
      if ((value.definition.configuration.agent === 'pi') !== (value.definition.model !== null)) return yield* fail('invalid-state')
      const definition = { ...value.definition, configuration: { ...value.definition.configuration,
        skillIds: [...new Set(value.definition.configuration.skillIds)].sort(),
        integrationIds: [...new Set(value.definition.configuration.integrationIds)].sort() } }
      return yield* sql.withTransaction(Effect.gen(function*() {
        const [previous] = yield* sql`SELECT id, definition, revision, created_at AS createdAt, updated_at AS updatedAt
          FROM routines WHERE id=${value.id}`.pipe(Effect.flatMap(records))
        if (definition.enabled && (yield* sql`SELECT r.id FROM routine_triggers rt JOIN runs r ON r.task_id=rt.task_id
          WHERE rt.routine_id=${value.id} AND r.sync_state='conflict' LIMIT 1`).length) {
          return yield* new HarnessStoreError({ reason: 'routine-conflict',
            message: 'Resolve this Routine’s synchronization conflicts before enabling it.' })
        }
        const revision = (value.expectedRevision ?? 0) + 1
        if (previous?.revision === revision && JSON.stringify(previous.definition) === JSON.stringify(definition)) return previous
        if (previous ? previous.revision !== value.expectedRevision : value.expectedRevision !== null) return yield* fail('invalid-state')
        const time = yield* now
        if (previous) yield* sql`UPDATE routines SET definition=${JSON.stringify(definition)}, revision=${revision}, updated_at=${time}
          WHERE id=${value.id} AND revision=${value.expectedRevision}`
        else yield* sql`INSERT INTO routines (id, definition, revision, created_at, updated_at)
          VALUES (${value.id}, ${JSON.stringify(definition)}, 1, ${time}, ${time})`
        if (previous && !previous.definition.enabled && definition.enabled) {
          // Re-enable can precede the first scheduler tick after restart. Skip the paused interval
          // atomically with the definition change, while retaining already accepted wakeups.
          const [schedule] = yield* sql`SELECT s.time, v.time_zone AS timeZone FROM routine_schedules s
            JOIN vault_schedule_settings v ON v.id=1 WHERE s.routine_id=${value.id}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ time: DailyTime, timeZone: VaultTimeZone })))))
          if (schedule) yield* sql`UPDATE routine_schedules SET next_at=${nextDailyOccurrence(schedule.time, schedule.timeZone, time)}
            WHERE routine_id=${value.id}`
        }
        return { id: value.id, definition, revision, createdAt: previous?.createdAt ?? time, updatedAt: time }
      }))
    }, Effect.mapError(safe))

    /** Persist one accepted occurrence before filesystem work; retries never consult a newer definition. */
    const claim = Effect.fn('RoutineStore.claim')(function*(input: TriggerRoutine) {
      const value = yield* Schema.decodeUnknownEffect(TriggerRoutine)(input, { onExcessProperty: 'error' })
      return yield* sql.withTransaction(Effect.gen(function*() {
        const [previous] = yield* sql`SELECT id, routine_id AS routineId, expected_revision AS expectedRevision,
          task_id AS taskId, snapshot, created_at AS createdAt FROM routine_triggers WHERE id=${value.id}`.pipe(Effect.flatMap(triggers))
        if (previous) {
          if (previous.routineId !== value.routineId || previous.expectedRevision !== value.expectedRevision) return yield* fail('invalid-state')
          return previous
        }
        const [snapshot] = yield* sql`SELECT id, definition, revision, created_at AS createdAt, updated_at AS updatedAt
          FROM routines WHERE id=${value.routineId}`.pipe(Effect.flatMap(records))
        if (!snapshot) return yield* fail('not-found')
        if (!snapshot.definition.enabled || snapshot.revision !== value.expectedRevision) return yield* fail('invalid-state')
        const taskId = randomUUID()
        const createdAt = yield* now
        yield* sql`INSERT INTO routine_triggers (id, routine_id, expected_revision, task_id, snapshot, created_at)
          VALUES (${value.id}, ${value.routineId}, ${value.expectedRevision}, ${taskId}, ${JSON.stringify(snapshot)}, ${createdAt})`
        return { ...value, taskId, snapshot, createdAt }
      }))
    }, Effect.mapError(safe))

    /** Looks up both reserved and materialized Task origins, so manual creation cannot claim a reserved ID. */
    const forTask = Effect.fn('RoutineStore.forTask')((taskId: string) => sql`SELECT id, routine_id AS routineId,
      expected_revision AS expectedRevision, task_id AS taskId, snapshot, created_at AS createdAt
      FROM routine_triggers WHERE task_id=${taskId}`.pipe(Effect.flatMap(triggers), Effect.map(rows => rows[0] ?? null)), Effect.mapError(safe))
    /** Includes accepted occurrences without a Task yet, allowing recovery after application restart. */
    const history = Effect.fn('RoutineStore.triggers')((routineId: string) => sql`SELECT id, routine_id AS routineId,
      expected_revision AS expectedRevision, task_id AS taskId, snapshot, created_at AS createdAt
      FROM routine_triggers WHERE routine_id=${routineId} ORDER BY created_at DESC, id`.pipe(
      Effect.flatMap(triggers)), Effect.mapError(safe))
    /** Allocate the first dispatch once; no native startup or Prompt is performed by this intent write. */
    const prepareExecution = Effect.fn('RoutineStore.prepareExecution')(function*(triggerId: string) {
      yield* Schema.decodeUnknownEffect(RoutineTrigger.fields.id)(triggerId)
      return yield* sql.withTransaction(Effect.gen(function*() {
        const [previous] = yield* sql`SELECT trigger_id AS triggerId, session_id AS sessionId, run_id AS runId,
          created_at AS createdAt FROM routine_executions WHERE trigger_id=${triggerId}`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(RoutineExecution))))
        if (previous) return previous
        const owner = yield* sql`SELECT t.id FROM routine_triggers rt JOIN tasks t ON t.id=rt.task_id
          WHERE rt.id=${triggerId} AND t.state='active' AND t.worktree_state='ready'`
        if (!owner.length) return yield* fail('invalid-state')
        const value = { triggerId, sessionId: randomUUID(), runId: randomUUID(), createdAt: yield* now }
        yield* sql`INSERT INTO routine_executions (trigger_id, session_id, run_id, created_at)
          VALUES (${triggerId}, ${value.sessionId}, ${value.runId}, ${value.createdAt})`
        return value
      }))
    }, Effect.mapError(safe))
    /** Record every occurrence once, without freezing configuration or allocating a Task while busy. */
    const enqueue = Effect.fn('RoutineStore.enqueue')(function*(input: EnqueueRoutine) {
      const value = yield* Schema.decodeUnknownEffect(EnqueueRoutine)(input, { onExcessProperty: 'error' })
      return yield* sql.withTransaction(Effect.gen(function*() {
        const [previous] = yield* sql`SELECT id, routine_id AS routineId, triggered_at AS triggeredAt,
          received_at AS receivedAt, trigger_id AS triggerId FROM routine_wakeups WHERE id=${value.id}`.pipe(Effect.flatMap(wakeupRows))
        if (previous) {
          if (previous.routineId !== value.routineId || previous.triggeredAt !== value.triggeredAt) return yield* fail('invalid-state')
          return previous
        }
        const [routine] = yield* sql`SELECT id, definition, revision, created_at AS createdAt, updated_at AS updatedAt
          FROM routines WHERE id=${value.routineId}`.pipe(Effect.flatMap(records))
        if (!routine) return yield* fail('not-found')
        if (!routine.definition.enabled) return yield* fail('invalid-state')
        const receivedAt = yield* now
        yield* sql`INSERT INTO routine_wakeups (id, routine_id, triggered_at, received_at)
          VALUES (${value.id}, ${value.routineId}, ${value.triggeredAt}, ${receivedAt})`
        return { ...value, receivedAt, triggerId: null }
      }))
    }, Effect.mapError(safe))
    /** Individual scheduled times remain queryable after coalescing and application restart. */
    const wakeups = Effect.fn('RoutineStore.wakeups')((routineId: string) => sql`SELECT id, routine_id AS routineId,
      triggered_at AS triggeredAt, received_at AS receivedAt, trigger_id AS triggerId FROM routine_wakeups
      WHERE routine_id=${routineId} ORDER BY triggered_at, id`.pipe(Effect.flatMap(wakeupRows)), Effect.mapError(safe))
    /** Atomically accepts all currently pending occurrences using the definition at dispatch time.
     * Reuses an accepted batch lacking its first Run after a crash; never allocates a replacement Prompt.
     * The Run reservation still rechecks concurrency because manual execution can race after this transaction.
     */
    const claimPending = Effect.fn('RoutineStore.claimPending')(function*(routineId: string) {
      yield* Schema.decodeUnknownEffect(RoutineRecord.fields.id)(routineId)
      return yield* sql.withTransaction(Effect.gen(function*() {
        const [routine] = yield* sql`SELECT id, definition, revision, created_at AS createdAt, updated_at AS updatedAt
          FROM routines WHERE id=${routineId}`.pipe(Effect.flatMap(records))
        if (!routine) return yield* fail('not-found')
        if (!routine.definition.enabled) return null
        const blocked = yield* sql`SELECT r.id FROM routine_triggers rt JOIN runs r ON r.task_id=rt.task_id
          JOIN tasks t ON t.id=r.task_id WHERE rt.routine_id=${routineId}
          AND (r.state IN ('preparing', 'running') OR r.sync_state='conflict'
            OR (r.state='succeeded' AND (r.sync_state NOT IN ('completed', 'not-required') OR t.state<>'completed'))) LIMIT 1`
        if (blocked.length) return null
        // New occurrences arriving after an accepted batch belong to the next batch, even if startup is delayed.
        const [accepted] = yield* sql`SELECT rt.id, rt.routine_id AS routineId, rt.expected_revision AS expectedRevision,
          rt.task_id AS taskId, rt.snapshot, rt.created_at AS createdAt FROM routine_triggers rt
          WHERE rt.routine_id=${routineId} AND EXISTS (SELECT 1 FROM routine_wakeups w WHERE w.trigger_id=rt.id)
          AND NOT EXISTS (SELECT 1 FROM routine_executions e JOIN runs r ON r.id=e.run_id WHERE e.trigger_id=rt.id)
          ORDER BY rt.created_at, rt.id LIMIT 1`.pipe(Effect.flatMap(triggers))
        if (accepted) return accepted
        if (!(yield* sql`SELECT id FROM routine_wakeups WHERE routine_id=${routineId} AND trigger_id IS NULL LIMIT 1`).length) return null
        const trigger = yield* claim({ id: randomUUID(), routineId, expectedRevision: routine.revision })
        yield* sql`UPDATE routine_wakeups SET trigger_id=${trigger.id} WHERE routine_id=${routineId} AND trigger_id IS NULL`
        return trigger
      }))
    }, Effect.mapError(safe))
    return RoutineStore.of({ list, save, claim, forTask, triggers: history, prepareExecution, enqueue, wakeups, claimPending })
  }))
}
