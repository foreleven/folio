import { DateTime, Option, Schema } from 'effect'
import { RoutineRecord } from './routine'

/** Persisted named zone prevents changes to the host timezone from moving Vault schedules. */
export const VaultTimeZone = Schema.NonEmptyString.check(Schema.makeFilter(value => Option.isSome(DateTime.zoneMakeNamed(value))))
export const DailyTime = Schema.String.check(Schema.makeFilter(value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value)))
export const DailyRoutineSchedule = Schema.Struct({
  routineId: RoutineRecord.fields.id, time: DailyTime,
  revision: Schema.Int.check(Schema.isGreaterThan(0)), nextAt: Schema.Number
})
export type DailyRoutineSchedule = typeof DailyRoutineSchedule.Type
export const SaveDailyRoutineSchedule = Schema.Struct({
  routineId: RoutineRecord.fields.id, time: DailyTime,
  expectedRevision: Schema.NullOr(DailyRoutineSchedule.fields.revision)
})
export type SaveDailyRoutineSchedule = typeof SaveDailyRoutineSchedule.Type

/** One occurrence per civil date: spring gaps move forward, autumn repeats use the earlier instant.
 * The strict next boundary prevents repeating a fired local day after a clock rollback or DST fold.
 */
export function nextDailyOccurrence(time: string, timeZone: string, after: number): number {
  Schema.decodeUnknownSync(DailyTime)(time)
  Schema.decodeUnknownSync(VaultTimeZone)(timeZone)
  const [hours, minutes] = time.split(':').map(Number)
  const local = DateTime.makeZonedUnsafe(after, { timeZone })
  const parts = DateTime.toParts(local)
  const date = DateTime.makeUnsafe({ year: parts.year, month: parts.month, day: parts.day })
  for (let offset = 0; offset < 3; offset++) {
    const day = DateTime.toPartsUtc(DateTime.add(date, { days: offset }))
    const candidate = DateTime.toEpochMillis(DateTime.makeZonedUnsafe({
      year: day.year, month: day.month, day: day.day, hour: hours!, minute: minutes!, second: 0, millisecond: 0
    }, { timeZone, adjustForTimeZone: true, disambiguation: 'compatible' }))
    if (candidate > after) return candidate
  }
  throw new Error('Could not determine the next daily occurrence')
}
