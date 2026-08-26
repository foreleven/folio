import { injectable } from 'inversify'
import type {
  JsonRpcCall,
  JsonRpcFailure,
  JsonRpcId,
  JsonRpcParams,
  JsonRpcResponse,
  RpcNamespace,
  RpcNamespaceHandler
} from '../../shared/rpc'
import { RPC_METHODS } from '../../shared/rpc'
import { JsonRpcError } from './errors'

const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INTERNAL_ERROR = -32603

/** Stable DI token for the process-wide RPC server. */
export const RpcServer = Symbol.for('folio.rpc.RpcServer')

/** Registers namespace handlers and dispatches serialized JSON-RPC messages. */
export interface RpcServer {
  /** Registers every method declared by one handler under a shared namespace. */
  register<Namespace extends RpcNamespace>(
    namespace: Namespace,
    handler: RpcNamespaceHandler<Namespace>
  ): void

  /** Parses, validates, dispatches, and serializes one JSON-RPC message or batch. */
  handleMessage(message: unknown): Promise<string | undefined>
}

type RegisteredRpcMethod = (
  params: JsonRpcParams | undefined
) => unknown | Promise<unknown>

/** Dispatches serialized JSON-RPC 2.0 calls to registered namespace handlers. */
@injectable()
export class JsonRpcServer implements RpcServer {
  private readonly handlers = new Map<string, RegisteredRpcMethod>()
  private readonly namespaces = new Set<string>()

  /** Registers the methods declared by one handler under a shared RPC namespace. */
  public register<Namespace extends RpcNamespace>(
    namespace: Namespace,
    handler: RpcNamespaceHandler<Namespace>
  ): void {
    if (this.namespaces.has(namespace)) {
      throw new Error(`JSON-RPC namespace "${namespace}" is already registered`)
    }

    const methodPrefix = `${namespace}.`
    const registrations = new Map<string, RegisteredRpcMethod>()
    for (const qualifiedMethod of Object.keys(RPC_METHODS)) {
      if (!qualifiedMethod.startsWith(methodPrefix)) {
        continue
      }

      const methodName = qualifiedMethod.slice(methodPrefix.length)
      const method: unknown = Reflect.get(handler, methodName)
      if (typeof method !== 'function') {
        throw new Error(`JSON-RPC method "${qualifiedMethod}" is not implemented`)
      }

      // Only shared-contract methods are callable; helpers on the class remain process-private.
      registrations.set(qualifiedMethod, (params) => Reflect.apply(method, handler, [params]))
    }

    this.namespaces.add(namespace)
    for (const [qualifiedMethod, method] of registrations) {
      this.handlers.set(qualifiedMethod, method)
    }
  }

  /** Parses, validates, dispatches, and serializes one JSON-RPC message or batch. */
  public async handleMessage(message: unknown): Promise<string | undefined> {
    let payload: unknown

    if (typeof message !== 'string') {
      return JSON.stringify(this.createFailure(null, INVALID_REQUEST, 'Invalid Request'))
    }

    try {
      payload = JSON.parse(message)
    } catch {
      return JSON.stringify(this.createFailure(null, PARSE_ERROR, 'Parse error'))
    }

    if (Array.isArray(payload)) {
      if (payload.length === 0) {
        return JSON.stringify(this.createFailure(null, INVALID_REQUEST, 'Invalid Request'))
      }

      const responses = (
        await Promise.all(payload.map((item) => this.handleCall(item)))
      ).filter((response): response is JsonRpcResponse => response !== undefined)

      return responses.length === 0 ? undefined : JSON.stringify(responses)
    }

    const response = await this.handleCall(payload)
    return response === undefined ? undefined : JSON.stringify(response)
  }

  /** Dispatches one parsed call and suppresses responses for notifications. */
  private async handleCall(payload: unknown): Promise<JsonRpcResponse | undefined> {
    if (!this.isCall(payload)) {
      return this.createFailure(null, INVALID_REQUEST, 'Invalid Request')
    }

    const hasId = Object.prototype.hasOwnProperty.call(payload, 'id')
    const id = hasId ? (payload as JsonRpcCall & { id: JsonRpcId }).id : null
    const handler = this.handlers.get(payload.method)
    if (!handler) {
      return hasId ? this.createFailure(id, METHOD_NOT_FOUND, 'Method not found') : undefined
    }

    try {
      const result = await handler(payload.params)
      if (!hasId) {
        return undefined
      }

      return this.ensureSerializable(
        { jsonrpc: '2.0', result: result ?? null, id } satisfies JsonRpcResponse,
        id,
        payload.method
      )
    } catch (error: unknown) {
      if (!hasId) {
        if (!(error instanceof JsonRpcError)) {
          console.error(`JSON-RPC notification "${payload.method}" failed`, error)
        }
        return undefined
      }

      if (error instanceof JsonRpcError) {
        return this.ensureSerializable(
          { jsonrpc: '2.0', error: error.toObject(), id } satisfies JsonRpcFailure,
          id,
          payload.method
        )
      }

      console.error(`JSON-RPC method "${payload.method}" failed`, error)
      return this.createFailure(id, INTERNAL_ERROR, 'Internal error')
    }
  }

  /** Checks a call envelope before any application handler sees it. */
  private isCall(payload: unknown): payload is JsonRpcCall {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return false
    }

    const request = payload as Record<string, unknown>
    const hasId = Object.prototype.hasOwnProperty.call(request, 'id')
    const hasValidId =
      !hasId ||
      typeof request.id === 'string' ||
      typeof request.id === 'number' ||
      request.id === null
    const hasValidParams =
      request.params === undefined ||
      Array.isArray(request.params) ||
      (typeof request.params === 'object' && request.params !== null)

    return (
      request.jsonrpc === '2.0' &&
      typeof request.method === 'string' &&
      request.method.length > 0 &&
      hasValidId &&
      hasValidParams
    )
  }

  /** Replaces values that cannot cross JSON with a safe internal-error response. */
  private ensureSerializable(
    response: JsonRpcResponse,
    id: JsonRpcId,
    method: string
  ): JsonRpcResponse {
    try {
      const serialized = JSON.stringify(response)
      const serializedResponse: unknown = JSON.parse(serialized)

      if (!this.isResponseEnvelope(serializedResponse)) {
        throw new TypeError('Serialization removed required JSON-RPC response fields')
      }

      return response
    } catch (error: unknown) {
      console.error(`JSON-RPC method "${method}" returned a non-serializable response`, error)
      return this.createFailure(id, INTERNAL_ERROR, 'Internal error')
    }
  }

  /** Checks that serialization preserved exactly one response payload field. */
  private isResponseEnvelope(response: unknown): response is JsonRpcResponse {
    if (typeof response !== 'object' || response === null || Array.isArray(response)) {
      return false
    }

    const value = response as Record<string, unknown>
    const hasResult = Object.prototype.hasOwnProperty.call(value, 'result')
    const hasError = Object.prototype.hasOwnProperty.call(value, 'error')
    return value.jsonrpc === '2.0' && hasResult !== hasError
  }

  /** Builds a protocol failure without leaking process-side exception details. */
  private createFailure(id: JsonRpcId, code: number, message: string): JsonRpcFailure {
    return { jsonrpc: '2.0', error: { code, message }, id }
  }
}
