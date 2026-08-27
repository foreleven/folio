import { Container } from 'inversify'
import { SystemRpcHandler } from '../../../shared/handlers/system-rpc-handler'
import { DesktopRpcProxy, RpcProxy } from '../rpc/rpc-proxy'

/** Creates the renderer composition root and binds RPC handlers through one proxy. */
export function createRendererContainer(): Container {
  const container = new Container()
  const rpcProxy: RpcProxy = new DesktopRpcProxy()

  container.bind<RpcProxy>(RpcProxy).toConstantValue(rpcProxy)
  container
    .bind<SystemRpcHandler>(SystemRpcHandler)
    .toConstantValue(rpcProxy.createClient<SystemRpcHandler>('system'))

  return container
}
