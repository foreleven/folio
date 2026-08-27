import type { SystemService } from '../../../shared/services/system-service'

interface RendererRpcServices {
  system: SystemService
}

type RpcNamespace = keyof RendererRpcServices

/** Stable DI token for the renderer's sole RPC service proxy. */
export const RpcProxy = Symbol.for('folio.renderer.RpcProxy')

/** Creates typed client implementations for registered server namespaces. */
export interface RpcProxy {
  /** Returns the cached client implementation for one server namespace. */
  getService<Namespace extends RpcNamespace>(
    namespace: Namespace
  ): RendererRpcServices[Namespace]
}

/** Maps injected service method calls onto the isolated preload RPC bridge. */
export class DesktopRpcProxy implements RpcProxy {
  private readonly services = new Map<RpcNamespace, object>()

  /** Returns one proxy per namespace so every injection shares the same service identity. */
  public getService<Namespace extends RpcNamespace>(
    namespace: Namespace
  ): RendererRpcServices[Namespace] {
    const existingService = this.services.get(namespace)
    if (existingService) {
      return existingService as RendererRpcServices[Namespace]
    }

    const service = new Proxy(Object.create(null) as object, {
      get: (_target, property) => {
        if (typeof property !== 'string' || property === 'then') {
          return undefined
        }

        return (...args: readonly unknown[]): Promise<unknown> => {
          const method = `${namespace}.${property}`
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

    this.services.set(namespace, service)
    return service as RendererRpcServices[Namespace]
  }
}
