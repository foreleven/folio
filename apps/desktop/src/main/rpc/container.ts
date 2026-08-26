import { Container } from 'inversify'
import {
  DefaultSystemRpcHandler,
  SystemRpcHandler
} from './handlers/system-rpc-handler'
import { JsonRpcServer, RpcServer } from './server'
import { ElectronSystemService, SystemService } from '../services/system-service'

/** Creates the main-process composition root for RPC services and handlers. */
export function createRpcContainer(): Container {
  const container = new Container()

  container.bind<SystemService>(SystemService).to(ElectronSystemService).inSingletonScope()
  container.bind<RpcServer>(RpcServer).to(JsonRpcServer).inSingletonScope()
  container
    .bind<SystemRpcHandler>(SystemRpcHandler)
    .to(DefaultSystemRpcHandler)
    .inSingletonScope()

  // Resolve self-registering handlers before the completed container becomes observable.
  container.get<SystemRpcHandler>(SystemRpcHandler)

  return container
}

/** Returns the process-wide RPC server from the completed composition root. */
export function getRpcServer(container: Container): RpcServer {
  return container.get<RpcServer>(RpcServer)
}
