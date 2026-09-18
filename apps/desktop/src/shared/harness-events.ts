import { Schema } from 'effect'

const Positive = Schema.Int.check(Schema.isGreaterThan(0))
/** Folio's archive-position extension is explicit; arbitrary ACP servers need a separate replay strategy. */
export const RecordedUpdate = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  runId: Schema.NullOr(Schema.NonEmptyString),
  connectionId: Schema.NonEmptyString,
  notification: Schema.Struct({
    sessionId: Schema.NonEmptyString,
    update: Schema.JsonObject,
    _meta: Schema.Struct({ 'folio/eventSequence': Positive })
  })
})
export type RecordedUpdate = typeof RecordedUpdate.Type

export const ProjectedMessage = Schema.Struct({
  role: Schema.Literals(['user', 'assistant', 'thought']),
  content: Schema.Array(Schema.Json), metadata: Schema.NullOr(Schema.JsonObject), ended: Schema.Boolean
})
export type ProjectedMessage = typeof ProjectedMessage.Type
/**
 * Archive positions and provider IDs are payload metadata, distinct from Folio's
 * durable message identity and session-local seq.
 */
export const MessagePayload = Schema.Struct({
  kind: Schema.Literals(['message', 'tool_call', 'acp_update']),
  protocolId: Schema.String, firstSequence: Schema.Int, lastSequence: Schema.Int, data: Schema.JsonObject
})

/** Dialogue and tool calls are messages; other events are custom. Transport IDs belong in payload. */
export const MessageRecord = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  runId: Schema.NullOr(Schema.String),
  seq: Positive,
  type: Schema.Literals(['message', 'custom']),
  timestamp: Schema.Number,
  payload: MessagePayload
})
export type MessageRecord = typeof MessageRecord.Type
