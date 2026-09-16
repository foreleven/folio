import { DateTime, Schema } from 'effect'
import { AgentKind } from './harness'
import { SessionModelSelection } from './model'

const Id = Schema.String.check(Schema.isUUID())
const Text = Schema.NonEmptyString.check(Schema.makeFilter((value) => value.trim().length > 0))
const RoutineDate = Schema.String.check(Schema.makeFilter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)))

/** Flat editable Routine configuration. Historical executions retain the revision used at dispatch. */
export const RoutineRecord = Schema.Struct({
  id: Id, name: Text, prompt: Text, agent: AgentKind, model: Schema.NullOr(SessionModelSelection),
  skillIds: Schema.Array(Schema.NonEmptyString), integrationIds: Schema.Array(Schema.NonEmptyString),
  resourceIds: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  intervalMinutes: Schema.Int.check(Schema.isGreaterThan(0)), timeZone: Schema.NonEmptyString,
  enabled: Schema.Boolean, revision: Schema.Int.check(Schema.isGreaterThan(0)),
  nextTriggerAt: Schema.NullOr(Schema.Number), lastTriggerAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number, updatedAt: Schema.Number
})
export type RoutineRecord = typeof RoutineRecord.Type

export const SaveRoutine = Schema.Struct({
  id: Id, expectedRevision: Schema.NullOr(RoutineRecord.fields.revision), name: Text, prompt: Text, agent: AgentKind,
  model: Schema.NullOr(SessionModelSelection), skillIds: Schema.Array(Schema.NonEmptyString),
  integrationIds: Schema.Array(Schema.NonEmptyString), intervalMinutes: RoutineRecord.fields.intervalMinutes,
  resourceIds: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  timeZone: RoutineRecord.fields.timeZone, enabled: Schema.Boolean
})
export type SaveRoutine = typeof SaveRoutine.Type

export const RoutineExecutionStatus = Schema.Literals(['pending', 'preparing', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'])
export type RoutineExecutionStatus = typeof RoutineExecutionStatus.Type

/** One logical processing window. taskId is null only during durable Task reservation. */
export const RoutineExecution = Schema.Struct({
  id: Id, routineId: Id, taskId: Schema.NullOr(Id), routineDate: RoutineDate, triggerTime: Schema.Number,
  firstTriggerTime: Schema.Number, triggerCount: Schema.Int.check(Schema.isGreaterThan(0)), isEnd: Schema.Boolean,
  windowStart: Schema.NullOr(Schema.Number), windowEnd: Schema.NullOr(Schema.Number),
  routineRevision: Schema.Int.check(Schema.isGreaterThan(0)), status: RoutineExecutionStatus,
  startedAt: Schema.NullOr(Schema.Number), endedAt: Schema.NullOr(Schema.Number), createdAt: Schema.Number, updatedAt: Schema.Number
})
export type RoutineExecution = typeof RoutineExecution.Type

export const RunRoutine = Schema.Struct({ routineId: Id, requestId: Schema.optionalKey(Id) })
export type RunRoutine = typeof RunRoutine.Type

/** Converts an instant into a civil date in the Routine's named timezone. */
export function routineDateAt(at: number, timeZone: string): string {
  const parts = DateTime.toParts(DateTime.makeZonedUnsafe(at, { timeZone }))
  return `${parts.year.toString().padStart(4, '0')}-${parts.month.toString().padStart(2, '0')}-${parts.day.toString().padStart(2, '0')}`
}

/** Returns the local end-of-day instant used by a day-closing execution. */
export function routineDayEnd(date: string, timeZone: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return DateTime.toEpochMillis(DateTime.makeZonedUnsafe({ year, month, day, hour: 23, minute: 59, second: 59, millisecond: 999 }, { timeZone, adjustForTimeZone: true, disambiguation: 'compatible' }))
}

/** Returns the previous civil date without using the host timezone. */
export function previousRoutineDate(date: string, timeZone: string): string {
  const [year, month, day] = date.split('-').map(Number)
  const instant = DateTime.toEpochMillis(DateTime.makeZonedUnsafe({ year, month, day, hour: 12, minute: 0, second: 0, millisecond: 0 }, { timeZone }))
  const previous = DateTime.add(DateTime.makeZonedUnsafe(instant, { timeZone }), { days: -1 })
  return routineDateAt(DateTime.toEpochMillis(previous), timeZone)
}
