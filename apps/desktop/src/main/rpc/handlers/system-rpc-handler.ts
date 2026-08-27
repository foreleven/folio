import { inject, injectable } from 'inversify'
import {
  SYSTEM_RPC_DEFINITION,
  SystemRpcHandler,
  type SystemInfo
} from '../../../shared/handlers/system-rpc-handler'
import { RpcHandlerMethods, type RegisteredRpcHandler } from '../../../shared/rpc'
import { SystemService } from '../../services/system-service'
import { JsonRpcError } from '../errors'
import { RpcServer } from '../server'

/** Process implementation of the public system namespace. */
@injectable()
export class DefaultSystemRpcHandler implements SystemRpcHandler, RegisteredRpcHandler {
  /** Restricts server registration to methods declared by the shared handler contract. */
  public readonly [RpcHandlerMethods] = SYSTEM_RPC_DEFINITION.methods

  /**
   * Creates the handler and registers its namespace with the process-wide server.
   * The composition root resolves this singleton before exposing the completed RPC graph.
   */
  public constructor(
    @inject(RpcServer) rpcServer: RpcServer,
    @inject(SystemService) private readonly systemService: SystemService
  ) {
    // A namespace is registered once so new system methods stay on this cohesive handler.
    rpcServer.register(SYSTEM_RPC_DEFINITION.namespace, this)
  }

  /** Returns application metadata and rejects params because the client contract accepts none. */
  public async getInfo(params?: undefined): Promise<SystemInfo> {
    if (params !== undefined) {
      throw new JsonRpcError(-32602, 'Invalid params')
    }

    return this.systemService.getInfo()
  }
}
