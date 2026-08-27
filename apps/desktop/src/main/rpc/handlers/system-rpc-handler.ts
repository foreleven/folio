import { inject, injectable } from 'inversify'
import {
  SystemRpcHandler,
  type SystemInfo
} from '../../../shared/handlers/system-rpc-handler'
import { RpcServer } from '../server'
import { SystemService } from '../../services/system-service'

/** Process implementation of the public system namespace. */
@injectable()
export class DefaultSystemRpcHandler implements SystemRpcHandler {
  /**
   * Creates the handler and registers its namespace with the process-wide server.
   * The composition root resolves this singleton before exposing the completed RPC graph.
   */
  public constructor(
    @inject(RpcServer) rpcServer: RpcServer,
    @inject(SystemService) private readonly systemService: SystemService
  ) {
    // A namespace is registered once so new system methods stay on this cohesive handler.
    rpcServer.register('system', this)
  }

  /** Returns application metadata through the process-owned system service. */
  public getInfo(): SystemInfo {
    return this.systemService.getInfo()
  }
}
