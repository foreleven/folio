import { Schema } from 'effect'

const Positive = Schema.Int.check(Schema.isGreaterThan(0))
const DiagnosticByteLength = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1024 * 1024 + 1 }))
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

export const ProtocolAssociation = Schema.Struct({
  kind: Schema.Literals(['request', 'notification', 'response', 'error', 'invalid']),
  requestId: Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.NullOr(Schema.String), runId: Schema.NullOr(Schema.String)
})
export type ProtocolAssociation = typeof ProtocolAssociation.Type
/** A batch remains one frame; each member has independent request and Run attribution. */
export const RecordedProtocolFrame = Schema.Struct({
  sessionId: Schema.NonEmptyString, connectionId: Schema.NonEmptyString,
  direction: Schema.Literals(['inbound', 'outbound']), payload: Schema.Json,
  associations: Schema.Array(ProtocolAssociation)
})
export type RecordedProtocolFrame = typeof RecordedProtocolFrame.Type
export const ProtocolFrame = Schema.Struct({ ...RecordedProtocolFrame.fields,
  sequence: Positive, receivedAt: Schema.Number, protocolVersion: Schema.Int })
export type ProtocolFrame = typeof ProtocolFrame.Type

/**
 * A malformed NDJSON line is never persisted verbatim: it may contain credentials or user data.
 * The digest is only a diagnostic correlation key, while the bounded length identifies truncation.
 */
export const ProtocolDiagnostic = Schema.Struct({
  reason: Schema.Literals(['invalid-utf8', 'invalid-json', 'line-too-large']),
  /** Values above the cap are represented as MAX+1, meaning "at least this large". */
  byteLength: DiagnosticByteLength,
  sha256: Schema.String.check(Schema.makeFilter(value => /^[0-9a-f]{64}$/.test(value)))
})
export type ProtocolDiagnostic = typeof ProtocolDiagnostic.Type
export const RecordedProtocolDiagnostic = Schema.Struct({
  sessionId: Schema.NonEmptyString, connectionId: Schema.NonEmptyString,
  direction: Schema.Literal('inbound'), diagnostic: ProtocolDiagnostic
})
export type RecordedProtocolDiagnostic = typeof RecordedProtocolDiagnostic.Type
export const ProtocolDiagnosticRow = Schema.Struct({
  sequence: Positive, sessionId: Schema.NonEmptyString, connectionId: Schema.NonEmptyString,
  direction: Schema.Literal('inbound'), reason: ProtocolDiagnostic.fields.reason,
  byteLength: DiagnosticByteLength, sha256: ProtocolDiagnostic.fields.sha256, receivedAt: Schema.Number
})
export type ProtocolDiagnosticRow = typeof ProtocolDiagnosticRow.Type

export const ProjectedMessage = Schema.Struct({
  role: Schema.Literals(['user', 'assistant', 'thought']),
  content: Schema.Array(Schema.Json), metadata: Schema.NullOr(Schema.JsonObject), ended: Schema.Boolean
})
export type ProjectedMessage = typeof ProjectedMessage.Type
export const ProjectionRow = Schema.Struct({
  id: Schema.String,
  runId: Schema.NullOr(Schema.String),
  kind: Schema.Literals(['message', 'tool_call']),
  firstSequence: Positive, lastSequence: Positive,
  data: Schema.fromJsonString(Schema.JsonObject)
})
export type ProjectionRow = typeof ProjectionRow.Type
