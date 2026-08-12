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

export interface SystemInfo {
  platform:
    | 'aix'
    | 'android'
    | 'darwin'
    | 'freebsd'
    | 'haiku'
    | 'linux'
    | 'openbsd'
    | 'sunos'
    | 'win32'
    | 'cygwin'
    | 'netbsd'
  version: string
}

/** The shared method map is the compile-time contract between preload and renderer. */
export interface RpcMethodDefinitions {
  'system.getInfo': {
    params: undefined
    result: SystemInfo
  }
}

export type RpcMethod = keyof RpcMethodDefinitions

export interface DesktopRpcClient {
  /** Sends one JSON-RPC request and rejects with RpcClientError for protocol failures. */
  request<Method extends RpcMethod>(
    method: Method,
    ...args: RpcMethodDefinitions[Method]['params'] extends undefined
      ? []
      : [params: RpcMethodDefinitions[Method]['params']]
  ): Promise<RpcMethodDefinitions[Method]['result']>
}
