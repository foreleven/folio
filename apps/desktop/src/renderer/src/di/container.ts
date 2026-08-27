import { Container } from 'inversify'
import { SystemService } from '../../../shared/services/system-service'
import { DesktopRpcProxy, RpcProxy } from '../rpc/rpc-proxy'

/** Creates the renderer composition root and binds server services through one RPC proxy. */
export function createRendererContainer(): Container {
  const container = new Container()
  const rpcProxy: RpcProxy = new DesktopRpcProxy()

  container.bind<RpcProxy>(RpcProxy).toConstantValue(rpcProxy)
  container
    .bind<SystemService>(SystemService)
    .toConstantValue(rpcProxy.getService('system'))

  return container
}

/** Resolves the renderer's process-wide system service. */
export function getSystemService(container: Container): SystemService {
  return container.get<SystemService>(SystemService)
}
