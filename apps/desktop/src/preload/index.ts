import { contextBridge, ipcRenderer } from 'electron'
import type {
  DesktopRpcClient,
  JsonRpcFailure,
  JsonRpcResponse,
  RpcMethod,
  RpcMethodDefinitions
} from '../shared/rpc'
import { RPC_CHANNEL } from '../shared/rpc'

let nextRequestId = 0

/** A renderer-side protocol error with the JSON-RPC code and optional data attached. */
export class RpcClientError extends Error {
  public constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown
  ) {
    super(message)
    this.name = 'RpcClientError'
  }
}

/** Sends one typed request over the isolated Electron JSON-RPC transport. */
async function request<Method extends RpcMethod>(
  method: Method,
  ...args: RpcMethodDefinitions[Method]['params'] extends undefined
    ? []
    : [params: RpcMethodDefinitions[Method]['params']]
): Promise<RpcMethodDefinitions[Method]['result']> {
  const id = ++nextRequestId
  const message = JSON.stringify({
    jsonrpc: '2.0',
    method,
    ...(args.length === 0 ? {} : { params: args[0] }),
    id
  })
  const rawResponse: unknown = await ipcRenderer.invoke(RPC_CHANNEL, message)
  const response = parseResponse(rawResponse, id)

  if ('error' in response) {
    throw new RpcClientError(response.error.code, response.error.message, response.error.data)
  }

  return response.result as RpcMethodDefinitions[Method]['result']
}

/** Validates that main returned a matching JSON-RPC response envelope. */
function parseResponse(rawResponse: unknown, requestId: number): JsonRpcResponse {
  if (typeof rawResponse !== 'string') {
    throw new RpcClientError(-32000, 'Invalid response from main process')
  }

  let response: unknown
  try {
    response = JSON.parse(rawResponse)
  } catch {
    throw new RpcClientError(-32000, 'Invalid response from main process')
  }

  if (!isResponse(response) || response.id !== requestId) {
    throw new RpcClientError(-32000, 'Invalid response from main process')
  }

  return response
}

/** Narrows an untrusted parsed value to a JSON-RPC success or failure response. */
function isResponse(response: unknown): response is JsonRpcResponse {
  if (typeof response !== 'object' || response === null || Array.isArray(response)) {
    return false
  }

  const value = response as Record<string, unknown>
  const validId = typeof value.id === 'string' || typeof value.id === 'number' || value.id === null
  const validSuccess = 'result' in value && !('error' in value)
  const validFailure =
    !('result' in value) &&
    'error' in value &&
    typeof value.error === 'object' &&
    value.error !== null &&
    typeof (value.error as JsonRpcFailure['error']).code === 'number' &&
    typeof (value.error as JsonRpcFailure['error']).message === 'string'

  return value.jsonrpc === '2.0' && validId && (validSuccess || validFailure)
}

const desktopApi: DesktopRpcClient = Object.freeze({ request })

// Keep the renderer isolated from Node.js; all capabilities cross one validated
// JSON-RPC boundary instead of exposing Electron primitives.
contextBridge.exposeInMainWorld('desktop', desktopApi)
