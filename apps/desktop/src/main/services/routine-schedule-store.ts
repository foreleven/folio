import { Context, DateTime, Effect, Layer, Schema } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { randomUUID } from 'node:crypto'
import { HarnessStoreError } from '../../shared/harness'
import { DailyRoutineSchedule, nextDailyOccurrence, SaveDailyRoutineSchedule, VaultTimeZone } from '../../shared/routine-schedule'
import { RoutineStore } from './routine-store'

const now = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis))
const invalid = () => new HarnessStoreError({ reason: 'invalid-state', message: 'Daily schedule or Vault timezone has changed.' })
const safe = (error: unknown) => error instanceof HarnessStoreError ? error
  : new HarnessStoreError({ reason: 'storage', message: 'Could not update daily schedules.' })

/** Durable daily cursors and wakeup publication share one SQLite transaction; no Agent calls occur here. */
export class RoutineScheduleStore extends Context.Service<RoutineScheduleStore, {
  readonly settings: Effect.Effect<{ timeZone: string | null; schedules: readonly DailyRoutineSchedule[] }, HarnessStoreError>
  readonly setTimeZone: (timeZone: string, expected: string | null) => Effect.Effect<void, HarnessStoreError>
  readonly save: (input: SaveDailyRoutineSchedule) => Effect.Effect<DailyRoutineSchedule, HarnessStoreError>
  readonly remove: (routineId: string, expectedRevision: number) => Effect.Effect<void, HarnessStoreError>
  readonly collectDue: Effect.Effect<readonly string[], HarnessStoreError>
}>()('folio/services/RoutineScheduleStore') {
  static readonly layer = Layer.effect(RoutineScheduleStore, Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const routines = yield* RoutineStore
    const decode = Schema.decodeUnknownEffect(Schema.Array(DailyRoutineSchedule))
    const schedules = sql`SELECT routine_id AS routineId, time, revision, next_at AS nextAt FROM routine_schedules ORDER BY routine_id`.pipe(Effect.flatMap(decode))
    const zone = sql`SELECT time_zone AS timeZone FROM vault_schedule_settings WHERE id=1`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ timeZone: VaultTimeZone })))),
      Effect.map(rows => rows[0]?.timeZone ?? null))

    /** CAS protects concurrent timezone edits; changing a zone restarts cursors at the next future local time. */
    const setTimeZone = Effect.fn('RoutineScheduleStore.setTimeZone')(function*(value: string, expected: string | null) {
      yield* Schema.decodeUnknownEffect(VaultTimeZone)(value)
      yield* sql.withTransaction(Effect.gen(function*() {
        const previous = yield* zone
        if (previous === value) return
        if (previous !== expected) return yield* invalid()
        const time = yield* now
        yield* sql`INSERT INTO vault_schedule_settings (id, time_zone) VALUES (1, ${value})
          ON CONFLICT(id) DO UPDATE SET time_zone=excluded.time_zone`
        for (const schedule of yield* schedules) {
          yield* sql`UPDATE routine_schedules SET next_at=${nextDailyOccurrence(schedule.time, value, time)}, revision=revision+1
            WHERE routine_id=${schedule.routineId}`
        }
      }))
    }, Effect.mapError(safe))

    /** Exact lost-reply retries preserve the cursor; new/edited plans never synthesize pre-configuration history. */
    const save = Effect.fn('RoutineScheduleStore.save')(function*(input: SaveDailyRoutineSchedule) {
      const value = yield* Schema.decodeUnknownEffect(SaveDailyRoutineSchedule)(input, { onExcessProperty: 'error' })
      return yield* sql.withTransaction(Effect.gen(function*() {
        const timeZone = yield* zone
        if (!timeZone || !(yield* sql`SELECT id FROM routines WHERE id=${value.routineId}`).length) return yield* invalid()
        const previous = (yield* schedules).find(schedule => schedule.routineId === value.routineId)
        const revision = (value.expectedRevision ?? 0) + 1
        if (previous?.revision === revision && previous.time === value.time) return previous
        if (previous ? previous.revision !== value.expectedRevision : value.expectedRevision !== null) return yield* invalid()
        const nextAt = nextDailyOccurrence(value.time, timeZone, yield* now)
        yield* sql`INSERT INTO routine_schedules (routine_id, time, revision, next_at)
          VALUES (${value.routineId}, ${value.time}, ${revision}, ${nextAt}) ON CONFLICT(routine_id)
          DO UPDATE SET time=excluded.time, revision=excluded.revision, next_at=excluded.next_at`
        return { routineId: value.routineId, time: value.time, revision, nextAt }
      }))
    }, Effect.mapError(safe))

    /** Removing a schedule retains already accepted wakeups and Task history. */
    const remove = Effect.fn('RoutineScheduleStore.remove')(function*(routineId: string, expectedRevision: number) {
      yield* Schema.decodeUnknownEffect(DailyRoutineSchedule.fields.routineId)(routineId)
      yield* sql.withTransaction(Effect.gen(function*() {
        const previous = (yield* schedules).find(schedule => schedule.routineId === routineId)
        if (!previous) return
        if (previous.revision !== expectedRevision) return yield* invalid()
        yield* sql`DELETE FROM routine_schedules WHERE routine_id=${routineId}`
      }))
    }, Effect.mapError(safe))

    /** Collect missed civil dates before dispatch so they coalesce into one pending batch.
     * A bounded page avoids long SQLite locks after extended downtime; callers drain more pages
     * before dispatch when cursors remain due. Paused dates are skipped, prior wakeups retained.
     */
    const collectDue = sql.withTransaction(Effect.gen(function*() {
      const timeZone = yield* zone
      if (!timeZone) return []
      const time = yield* now
      const definitions = yield* routines.list
      const touched: string[] = []
      for (const schedule of yield* schedules) {
        if (schedule.nextAt > time) continue
        const routine = definitions.find(record => record.id === schedule.routineId)
        if (!routine) return yield* invalid()
        let nextAt = schedule.nextAt
        if (!routine.definition.enabled) nextAt = nextDailyOccurrence(schedule.time, timeZone, time)
        else {
          for (let count = 0; nextAt <= time && count < 366; count++) {
            yield* routines.enqueue({ id: randomUUID(), routineId: schedule.routineId, triggeredAt: nextAt })
            nextAt = nextDailyOccurrence(schedule.time, timeZone, nextAt)
          }
          touched.push(schedule.routineId)
        }
        yield* sql`UPDATE routine_schedules SET next_at=${nextAt} WHERE routine_id=${schedule.routineId}`
      }
      return touched
    })).pipe(Effect.mapError(safe))
    return RoutineScheduleStore.of({ settings: Effect.gen(function*() { return { timeZone: yield* zone, schedules: yield* schedules } }).pipe(Effect.mapError(safe)),
      setTimeZone, save, remove, collectDue })
  }))
}
