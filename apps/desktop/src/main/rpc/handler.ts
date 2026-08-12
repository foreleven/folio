import type { JsonRpcParams, RpcMethod, RpcMethodDefinitions } from '../../shared/rpc'

/** A single JSON-RPC method implementation registered with the server. */
export interface JsonRpcMethodHandler<Method extends string = string, Result = unknown> {
  readonly method: Method

  /** Validates wire params and returns a JSON-serializable result. */
  handle(params: JsonRpcParams | undefined): Result | Promise<Result>
}

/** Binds a production handler's method and result to the shared renderer contract. */
export type TypedJsonRpcMethodHandler<Method extends RpcMethod> = JsonRpcMethodHandler<
  Method,
  RpcMethodDefinitions[Method]['result']
>
