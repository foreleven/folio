import { Schema } from 'effect'
import type { RpcMessage } from 'effect/unstable/rpc'

const RequestIdSchema = Schema.Union([Schema.String, Schema.Finite])
const RequestSchema = Schema.Struct({
  _tag: Schema.tag('Request'),
  id: RequestIdSchema,
  tag: Schema.String,
  // JSON omits schema holes whose encoded value is undefined.
  payload: Schema.optional(Schema.Unknown),
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  isNotification: Schema.optional(Schema.Literal(true)),
  traceId: Schema.optional(Schema.String),
  spanId: Schema.optional(Schema.String),
  sampled: Schema.optional(Schema.Boolean)
})
const ExitSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.tag('Success'),
    value: Schema.optional(Schema.Unknown)
  }),
  Schema.Struct({
    _tag: Schema.tag('Failure'),
    cause: Schema.Array(
      Schema.Union([
        Schema.Struct({
          _tag: Schema.tag('Fail'),
          error: Schema.optional(Schema.Unknown)
        }),
        Schema.Struct({
          _tag: Schema.tag('Die'),
          defect: Schema.optional(Schema.Unknown)
        }),
        Schema.Struct({
          _tag: Schema.tag('Interrupt'),
          fiberId: Schema.optional(Schema.Finite)
        })
      ])
    )
  })
])
const ClientMessageSchema = Schema.Union([
  RequestSchema,
  Schema.Struct({ _tag: Schema.tag('Ack'), requestId: RequestIdSchema }),
  Schema.Struct({ _tag: Schema.tag('Interrupt'), requestId: RequestIdSchema }),
  Schema.Struct({ _tag: Schema.tag('Ping') }),
  Schema.Struct({ _tag: Schema.tag('Eof') })
])
const ServerMessageSchema = Schema.Union([
  RequestSchema,
  Schema.Struct({
    _tag: Schema.tag('Chunk'),
    requestId: RequestIdSchema,
    values: Schema.NonEmptyArray(Schema.Unknown)
  }),
  Schema.Struct({
    _tag: Schema.tag('Exit'),
    requestId: RequestIdSchema,
    exit: ExitSchema
  }),
  Schema.Struct({
    _tag: Schema.tag('Defect'),
    defect: Schema.optional(Schema.Unknown)
  }),
  Schema.Struct({ _tag: Schema.tag('Pong') })
])

const isClientMessage = Schema.is(ClientMessageSchema)
const isServerMessage = Schema.is(ServerMessageSchema)

/** Validates an inner Effect RPC message received by the main process. */
export function isElectronRpcClientMessage(
  value: unknown
): value is RpcMessage.FromClientEncoded {
  return isClientMessage(value)
}

/** Validates an inner Effect RPC message received by the renderer. */
export function isElectronRpcServerMessage(
  value: unknown
): value is RpcMessage.FromServerEncoded {
  return isServerMessage(value)
}
