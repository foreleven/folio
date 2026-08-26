import { inject, injectable } from 'inversify'
import type { JsonRpcParams, SystemInfo } from '../../../shared/rpc'
import { JsonRpcError } from '../errors'
import { RpcServer } from '../server'
import { SystemService } from '../../services/system-service'

/** Implements every RPC method owned by the public system namespace. */
@injectable()
export class SystemRpcHandler {
  public constructor(
    @inject(RpcServer) rpcServer: RpcServer,
    @inject(SystemService) private readonly systemService: SystemService
  ) {
    // A namespace is registered once so new system methods stay on this cohesive handler.
    rpcServer.register('system', this)
  }

  /** Returns application metadata and rejects params because the contract accepts none. */
  public getInfo(params: JsonRpcParams | undefined): SystemInfo {
    if (params !== undefined) {
      throw new JsonRpcError(-32602, 'Invalid params')
    }

    return this.systemService.getInfo()
  }
}
