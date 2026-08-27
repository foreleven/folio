/** The single Electron IPC channel carrying serialized JSON-RPC messages. */
export const RPC_CHANNEL = 'folio:rpc'

export type JsonRpcId = string | number | null
export type JsonRpcParams = Record<string, unknown> | readonly unknown[]

export interface JsonRpcCall {
  jsonrpc: '2.0'
  method: string
  params?: JsonRpcParams
}

export interface JsonRpcRequest extends JsonRpcCall {
  id: JsonRpcId
}

export type JsonRpcNotification = JsonRpcCall

export interface JsonRpcSuccess<Result = unknown> {
  jsonrpc: '2.0'
  result: Result
  id: JsonRpcId
}

export interface JsonRpcErrorObject {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcFailure {
  jsonrpc: '2.0'
  error: JsonRpcErrorObject
  id: JsonRpcId
}

export type JsonRpcResponse<Result = unknown> = JsonRpcSuccess<Result> | JsonRpcFailure

declare const RPC_CLIENT_TYPE: unique symbol
declare const RPC_HANDLER_TYPE: unique symbol

/** A DI symbol branded with the RPC handler interface it resolves. */
export type RpcHandlerToken<Client extends object> = symbol & {
  readonly [RPC_HANDLER_TYPE]: Client
}

/** A namespace branded with the client interface its proxy must implement. */
export type RpcClientNamespace<Client extends object> = string & {
  readonly [RPC_CLIENT_TYPE]: Client
}

type IsRpcMethod<Method> = Method extends (...args: infer Args) => infer Result
  ? Args extends []
    ? Result extends Promise<unknown>
      ? true
      : false
    : Args extends [infer Params]
      ? Params extends JsonRpcParams
        ? Result extends Promise<unknown>
          ? true
          : false
        : false
      : false
  : false

type InvalidRpcClientMember<Client extends object> = {
  [Member in keyof Client]: Member extends string
    ? IsRpcMethod<Client[Member]> extends true
      ? never
      : Member
    : Member
}[keyof Client]

/** Runtime metadata for one RPC handler, checked against its client interface. */
export interface RpcClientDefinition<Client extends object> {
  namespace: RpcClientNamespace<Client>
  methods: readonly Extract<keyof Client, string>[]
}

/** Declares one RPC client contract without teaching the transport about the handler itself. */
export function defineRpcClient<Client extends object>(
  namespace: InvalidRpcClientMember<Client> extends never ? string : never,
  methods: { [Method in Extract<keyof Client, string>]: true }
): RpcClientDefinition<Client> {
  return {
    namespace: namespace as unknown as RpcClientNamespace<Client>,
    methods: Object.keys(methods) as Extract<keyof Client, string>[]
  }
}

/** Generic metadata key used by servers to discover explicitly exposed handler methods. */
export const RpcHandlerMethods = Symbol('folio.rpc.handlerMethods')

/** A server handler that explicitly declares which function members are remotely callable. */
export interface RegisteredRpcHandler {
  readonly [RpcHandlerMethods]: readonly string[]
}

export interface DesktopRpcClient {
  /** Sends one transport request; injected handler interfaces provide application types. */
  request(method: string, ...args: [] | [params: JsonRpcParams]): Promise<unknown>
}
