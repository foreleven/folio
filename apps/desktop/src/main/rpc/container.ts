import { Container } from 'inversify'
import { SystemRpcHandler } from './handlers/system-rpc-handler'
import { JsonRpcServer, RpcServer } from './server'
import { ElectronSystemService, SystemService } from '../services/system-service'

/** Creates the main-process composition root for RPC services and handlers. */
export function createRpcContainer(): Container {
  const container = new Container()

  container.bind<SystemService>(SystemService).to(ElectronSystemService).inSingletonScope()
  container.bind<RpcServer>(RpcServer).to(JsonRpcServer).inSingletonScope()
  container.bind(SystemRpcHandler).toSelf().inSingletonScope()

  return container
}

/** Resolves namespace handlers once, then returns the process-wide RPC server. */
export function getRpcServer(container: Container): RpcServer {
  container.get(SystemRpcHandler)
  return container.get<RpcServer>(RpcServer)
}
