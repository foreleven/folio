import {
  RPC_SERVICE_METHODS,
  type RpcNamespace,
  type RpcServices
} from '../../../shared/services/rpc-services'

/** Stable DI token for the renderer's sole RPC service proxy. */
export const RpcProxy = Symbol.for('folio.renderer.RpcProxy')

/** Creates typed client implementations for registered server namespaces. */
export interface RpcProxy {
  /** Creates a typed client implementation for one registered server namespace. */
  getService<Namespace extends RpcNamespace>(
    namespace: Namespace
  ): RpcServices[Namespace]
}

/** Maps injected service method calls onto the isolated preload RPC bridge. */
export class DesktopRpcProxy implements RpcProxy {
  /** Creates a typed service whose calls are restricted to the shared runtime route registry. */
  public getService<Namespace extends RpcNamespace>(
    namespace: Namespace
  ): RpcServices[Namespace] {
    const methods: Readonly<Record<string, string>> = RPC_SERVICE_METHODS[namespace]
    const service = new Proxy(Object.create(null) as object, {
      get: (_target, property) => {
        if (typeof property !== 'string') {
          return undefined
        }

        const method = methods[property]
        if (!method) {
          // Only registered service methods are exposed, which also prevents thenable proxies.
          return undefined
        }

        return (...args: readonly unknown[]): Promise<unknown> => {
          if (args.length === 0) {
            return window.desktop.request(method)
          }
          if (args.length === 1) {
            return window.desktop.request(method, args[0])
          }

          return Promise.reject(
            new TypeError('RPC service methods accept at most one params argument')
          )
        }
      }
    })

    return service as RpcServices[Namespace]
  }
}
