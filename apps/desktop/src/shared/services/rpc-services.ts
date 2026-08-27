import type { SystemService } from './system-service'

/** Service contracts that are implemented in main and injected into renderer. */
export interface RpcServices {
  system: SystemService
}

export type RpcNamespace = Extract<keyof RpcServices, string>

type RpcServiceMethodName<Namespace extends RpcNamespace> = Extract<
  keyof RpcServices[Namespace],
  string
>

type RpcServiceMethodRegistry = {
  [Namespace in RpcNamespace]: {
    [Method in RpcServiceMethodName<Namespace>]: `${Namespace}.${Method}`
  }
}

/** Runtime routes checked exhaustively against every shared service method. */
export const RPC_SERVICE_METHODS = {
  system: {
    getInfo: 'system.getInfo'
  }
} as const satisfies RpcServiceMethodRegistry

export type RpcMethod = {
  [Namespace in RpcNamespace]: `${Namespace}.${RpcServiceMethodName<Namespace>}`
}[RpcNamespace]

type RpcOperation<
  Namespace extends RpcNamespace,
  Method extends RpcServiceMethodName<Namespace>
> = RpcServices[Namespace][Method] extends (
  ...args: infer Args
) => infer Result
  ? {
      params: Args extends [] ? undefined : Args extends [infer Params] ? Params : never
      result: Awaited<Result>
    }
  : never

type RpcOperationFor<Method extends RpcMethod> =
  Method extends `${infer Namespace}.${infer ServiceMethod}`
    ? Namespace extends RpcNamespace
      ? ServiceMethod extends RpcServiceMethodName<Namespace>
        ? RpcOperation<Namespace, ServiceMethod>
        : never
      : never
    : never

/** JSON-RPC transport definitions derived from the injected service contracts. */
export type RpcMethodDefinitions = {
  [Method in RpcMethod]: RpcOperationFor<Method>
}

/** Server implementation required when registering one service namespace. */
export type RpcNamespaceHandler<Namespace extends RpcNamespace> =
  RpcServices[Namespace]
