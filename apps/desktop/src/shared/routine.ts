import { DateTime, Option, Schema } from 'effect'
import { AgentKind } from './harness'
import { SessionModelSelection } from './model'

export const RoutineId = Schema.String.check(Schema.isUUID())
const Text = Schema.NonEmptyString.check(Schema.makeFilter((value) => value.trim().length > 0))
export const RoutineTimeZone = Schema.NonEmptyString.check(Schema.makeFilter(value => Option.isSome(DateTime.zoneFromString(value)), { message: 'Invalid Routine time zone' }))

export const ScheduleTrigger = Schema.Struct({
  type: Schema.Literal('schedule'),
  intervalMinutes: Schema.Int.check(Schema.isGreaterThan(0)),
  timeZone: RoutineTimeZone
})
export type ScheduleTrigger = typeof ScheduleTrigger.Type
export const RawEventTrigger = Schema.Struct({ type: Schema.Literal('event'), signal: Schema.Literal('raws-changed') })
export type RawEventTrigger = typeof RawEventTrigger.Type
export const RoutineTrigger = Schema.Union([ScheduleTrigger, RawEventTrigger])

export const AgentRoutineConfiguration = Schema.Struct({
  goal: Text,
  agent: AgentKind,
  model: Schema.NullOr(SessionModelSelection),
  skillIds: Schema.Array(Schema.NonEmptyString), integrationIds: Schema.Array(Schema.NonEmptyString),
  resourceIds: Schema.Array(Schema.NonEmptyString)
})
export type AgentRoutineConfiguration = typeof AgentRoutineConfiguration.Type
export const IngestionRoutineConfiguration = Schema.Struct({
  integrationId: Schema.NonEmptyString,
  resourceId: Schema.NonEmptyString
})
export type IngestionRoutineConfiguration = typeof IngestionRoutineConfiguration.Type
export const RoutineConfiguration = Schema.Union([AgentRoutineConfiguration, IngestionRoutineConfiguration])
export type RoutineConfiguration = typeof RoutineConfiguration.Type

const RoutineIdentity = { id: RoutineId, name: Text }
const RoutineSchedule = {
  trigger: RoutineTrigger,
  enabled: Schema.Boolean, revision: Schema.Int.check(Schema.isGreaterThan(0)),
  nextTriggerAt: Schema.NullOr(Schema.Number), lastTriggerAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number, updatedAt: Schema.Number
}
/** Typed editable Routine definition. Historical Tasks retain the revision used at dispatch. */
export const RoutineRecord = Schema.Union([
  Schema.Struct({ ...RoutineIdentity, ...RoutineSchedule, type: Schema.Literal('agent'), configuration: AgentRoutineConfiguration }),
  Schema.Struct({ ...RoutineIdentity, ...RoutineSchedule, trigger: ScheduleTrigger, type: Schema.Literal('ingestion'), configuration: IngestionRoutineConfiguration })
])
export type RoutineRecord = typeof RoutineRecord.Type

const SaveIdentity = { id: RoutineId, expectedRevision: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))), name: Text }
const SaveSchedule = {
  trigger: RoutineTrigger,
  enabled: Schema.Boolean
}
export const SaveRoutine = Schema.Union([
  Schema.Struct({ ...SaveIdentity, ...SaveSchedule, type: Schema.Literal('agent'), configuration: AgentRoutineConfiguration }),
  Schema.Struct({ ...SaveIdentity, ...SaveSchedule, trigger: ScheduleTrigger, type: Schema.Literal('ingestion'), configuration: IngestionRoutineConfiguration })
])
export type SaveRoutine = typeof SaveRoutine.Type

export const RoutineExecutionStatus = Schema.Literals(['pending', 'preparing', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'conflict'])
export type RoutineExecutionStatus = typeof RoutineExecutionStatus.Type

/** Read projection of a Routine Task and its latest Run; taskId is its only identity. */
export const RoutineExecution = Schema.Struct({
  routineId: RoutineId, taskId: RoutineId, type: Schema.Literals(['agent', 'ingestion']), runId: Schema.NullOr(Schema.String), cancelRequested: Schema.Boolean, routineDate: Schema.NullOr(Schema.String), triggerTime: Schema.Number,
  windowStart: Schema.NullOr(Schema.Number), windowEnd: Schema.NullOr(Schema.Number),
  model: Schema.NullOr(SessionModelSelection), timeZone: Schema.NullOr(RoutineTimeZone),
  routineRevision: Schema.Int.check(Schema.isGreaterThan(0)), status: RoutineExecutionStatus,
  startedAt: Schema.NullOr(Schema.Number), endedAt: Schema.NullOr(Schema.Number), createdAt: Schema.Number, updatedAt: Schema.Number
})
export type RoutineExecution = typeof RoutineExecution.Type

/** Scheduling requires a real source window; event Task history has no window. */
export const ScheduledRoutineExecution = Schema.Struct({ ...RoutineExecution.fields,
  routineDate: Schema.String, windowStart: Schema.Number, windowEnd: Schema.Number, timeZone: RoutineTimeZone })
export type ScheduledRoutineExecution = typeof ScheduledRoutineExecution.Type

export const RunRoutine = Schema.Struct({ routineId: RoutineId, requestId: Schema.optionalKey(RoutineId) })
export type RunRoutine = typeof RunRoutine.Type

/** Formats an execution instant in the Routine's named timezone for Agent-facing boundaries. */
export function routineTimestampAt(at: number, timeZone: string): string {
  return DateTime.formatIsoOffset(DateTime.makeZonedUnsafe(at, { timeZone }))
}

/** Converts an instant into a civil date in the Routine's named timezone. */
export function routineDateAt(at: number, timeZone: string): string {
  const parts = DateTime.toParts(DateTime.makeZonedUnsafe(at, { timeZone }))
  return `${parts.year.toString().padStart(4, '0')}-${parts.month.toString().padStart(2, '0')}-${parts.day.toString().padStart(2, '0')}`
}

/** First ingestion includes the entire civil day, even when a Routine is created midday. */
export function routineDayStart(date: string, timeZone: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return DateTime.toEpochMillis(DateTime.makeZonedUnsafe({ year, month, day, hour: 0, minute: 0, second: 0, millisecond: 0 }, { timeZone, adjustForTimeZone: true, disambiguation: 'compatible' }))
}

/** Returns the previous civil date without using the host timezone. */
export function previousRoutineDate(date: string, timeZone: string): string {
  const [year, month, day] = date.split('-').map(Number)
  const instant = DateTime.toEpochMillis(DateTime.makeZonedUnsafe({ year, month, day, hour: 12, minute: 0, second: 0, millisecond: 0 }, { timeZone, adjustForTimeZone: true, disambiguation: 'compatible' }))
  const previous = DateTime.add(DateTime.makeZonedUnsafe(instant, { timeZone }), { days: -1 })
  return routineDateAt(DateTime.toEpochMillis(previous), timeZone)
}

/** Day labels describe observed windows only, never infer whole-day completion. */
export function routineDateState(rows: readonly Pick<RoutineExecution, 'status'>[]): 'progress' | 'attention' {
  if (rows.some(row => ['failed', 'interrupted', 'cancelled', 'conflict'].includes(row.status))) return 'attention'
  return 'progress'
}
