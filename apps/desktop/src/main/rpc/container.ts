import { Container } from 'inversify'
import type { JsonRpcMethodHandler } from './handler'
import { SystemGetInfoHandler } from './handlers/system-get-info-handler'
import { JsonRpcServer } from './server'
import { SystemService } from '../services/system-service'
import { RPC_TYPES } from './types'

/** Creates the main-process composition root for RPC services and handlers. */
export function createRpcContainer(): Container {
  const container = new Container()

  container
    .bind<SystemService>(RPC_TYPES.systemService)
    .to(SystemService)
    .inSingletonScope()
  container
    .bind<JsonRpcMethodHandler>(RPC_TYPES.jsonRpcMethodHandler)
    .to(SystemGetInfoHandler)
    .inSingletonScope()
  container
    .bind<JsonRpcServer>(RPC_TYPES.jsonRpcServer)
    .to(JsonRpcServer)
    .inSingletonScope()

  return container
}

/** Resolves the process-wide JSON-RPC server from the configured container. */
export function getJsonRpcServer(container: Container): JsonRpcServer {
  return container.get<JsonRpcServer>(RPC_TYPES.jsonRpcServer)
}
