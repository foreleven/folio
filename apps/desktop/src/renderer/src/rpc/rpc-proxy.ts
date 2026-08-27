/** Stable DI token for the renderer's sole RPC service proxy. */
export const RpcProxy = Symbol.for('folio.renderer.RpcProxy')

/** Creates typed client implementations without knowing concrete RPC handlers. */
export interface RpcProxy {
  /** Creates a typed client whose method calls are forwarded under one namespace. */
  createClient<Client extends object>(namespace: string): Client
}

/** Maps injected service method calls onto the isolated preload RPC bridge. */
export class DesktopRpcProxy implements RpcProxy {
  /** Creates a client that maps zero- or one-argument calls to namespace.method requests. */
  public createClient<Client extends object>(namespace: string): Client {
    const client = new Proxy(Object.create(null) as object, {
      get: (_target, property) => {
        if (typeof property !== 'string' || property === 'then') {
          // Suppressing then prevents a dynamic client from being treated as a Promise.
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

    return client as Client
  }
}
