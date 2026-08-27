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

export interface DesktopRpcClient {
  /** Sends one transport request; injected handler interfaces provide application types. */
  request(method: string, ...args: [] | [params: JsonRpcParams]): Promise<unknown>
}
