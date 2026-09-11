import { Schema } from 'effect'
import { TaskConfiguration } from './harness'
import { SessionModelSelection } from './model'

const Id = Schema.String.check(Schema.isUUID())
const Text = Schema.NonEmptyString.check(Schema.makeFilter(value => value.trim().length > 0))
export const RoutineDefinition = Schema.Struct({
  name: Text, prompt: Text, configuration: TaskConfiguration, model: Schema.NullOr(SessionModelSelection), enabled: Schema.Boolean
})
export type RoutineDefinition = typeof RoutineDefinition.Type
export const RoutineRecord = Schema.Struct({
  id: Id, definition: RoutineDefinition, revision: Schema.Int.check(Schema.isGreaterThan(0)),
  createdAt: Schema.Number, updatedAt: Schema.Number
})
export type RoutineRecord = typeof RoutineRecord.Type
/** expectedRevision prevents stale editors from replacing a more recent definition; null means create. */
export const SaveRoutine = Schema.Struct({ id: Id, expectedRevision: Schema.NullOr(RoutineRecord.fields.revision), definition: RoutineDefinition })
export type SaveRoutine = typeof SaveRoutine.Type
/** A caller reuses its trigger UUID after a lost reply; the server allocates the Task identity once. */
export const TriggerRoutine = Schema.Struct({ id: Id, routineId: Id, expectedRevision: RoutineRecord.fields.revision })
export type TriggerRoutine = typeof TriggerRoutine.Type
export const RoutineTrigger = Schema.Struct({
  ...TriggerRoutine.fields, taskId: Id, snapshot: RoutineRecord, createdAt: Schema.Number
})
export type RoutineTrigger = typeof RoutineTrigger.Type
/** First-dispatch identities are allocated once, before a native Session or Run exists. */
export const RoutineExecution = Schema.Struct({ triggerId: Id, sessionId: Id, runId: Id, createdAt: Schema.Number })
export type RoutineExecution = typeof RoutineExecution.Type
/** A scheduler occurrence has a stable identity; repeated receipt does not create another pending run. */
export const EnqueueRoutine = Schema.Struct({
  id: Id, routineId: Id, triggeredAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(8_640_000_000_000_000))
})
export type EnqueueRoutine = typeof EnqueueRoutine.Type
/** Pending occurrences keep their individual times and acquire one shared trigger only at dispatch. */
export const RoutineWakeup = Schema.Struct({
  ...EnqueueRoutine.fields, receivedAt: Schema.Number, triggerId: Schema.NullOr(Id)
})
export type RoutineWakeup = typeof RoutineWakeup.Type
