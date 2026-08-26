import { inject, injectable } from 'inversify'
import type { RpcNamespaceHandler, SystemInfo } from '../../../shared/rpc'
import { JsonRpcError } from '../errors'
import { RpcServer } from '../server'
import { SystemService } from '../../services/system-service'

/** Stable DI token for the system namespace handler. */
export const SystemRpcHandler = Symbol.for('folio.rpc.SystemRpcHandler')

/** Contract for every RPC method owned by the public system namespace. */
export interface SystemRpcHandler extends RpcNamespaceHandler<'system'> {}

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

  /** Returns application metadata and rejects params because the contract accepts none. */
  public getInfo(params: undefined): SystemInfo {
    if (params !== undefined) {
      throw new JsonRpcError(-32602, 'Invalid params')
    }

    return this.systemService.getInfo()
  }
}
