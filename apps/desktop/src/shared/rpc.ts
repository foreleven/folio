import type { SystemInfo } from './services/system-service'

export type { SystemInfo } from './services/system-service'

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

/** Transport method map used by main dispatch and the isolated preload bridge. */
export interface RpcMethodDefinitions {
  'system.getInfo': {
    params: undefined
    result: SystemInfo
  }
}

export type RpcMethod = keyof RpcMethodDefinitions

/** Runtime method allowlist kept type-checked against the renderer RPC contract. */
export const RPC_METHODS = {
  'system.getInfo': true
} as const satisfies Record<RpcMethod, true>

/** Namespace prefixes represented by the shared RPC method contract. */
export type RpcNamespace = RpcMethod extends `${infer Namespace}.${string}`
  ? Namespace
  : never

/** Methods a namespace handler must implement, derived from the shared RPC contract. */
export type RpcNamespaceHandler<Namespace extends RpcNamespace> = {
  [Method in RpcMethod as Method extends `${Namespace}.${infer MethodName}`
    ? MethodName
    : never]: (
    params: RpcMethodDefinitions[Method]['params']
  ) =>
    | RpcMethodDefinitions[Method]['result']
    | Promise<RpcMethodDefinitions[Method]['result']>
}

export interface DesktopRpcClient {
  /** Sends one JSON-RPC request and rejects with RpcClientError for protocol failures. */
  request<Method extends RpcMethod>(
    method: Method,
    ...args: RpcMethodDefinitions[Method]['params'] extends undefined
      ? []
      : [params: RpcMethodDefinitions[Method]['params']]
  ): Promise<RpcMethodDefinitions[Method]['result']>
}
