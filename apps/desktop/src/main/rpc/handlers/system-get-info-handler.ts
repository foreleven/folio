import { inject, injectable } from 'inversify'
import type { JsonRpcParams, SystemInfo } from '../../../shared/rpc'
import { JsonRpcError } from '../errors'
import type { TypedJsonRpcMethodHandler } from '../handler'
import type { SystemService } from '../../services/system-service'
import { RPC_TYPES } from '../types'

/** Implements the public system.getInfo RPC method. */
@injectable()
export class SystemGetInfoHandler implements TypedJsonRpcMethodHandler<'system.getInfo'> {
  public readonly method = 'system.getInfo' as const

  public constructor(
    @inject(RPC_TYPES.systemService) private readonly systemService: SystemService
  ) {}

  /** Returns application metadata; this method intentionally accepts no params. */
  public handle(params: JsonRpcParams | undefined): SystemInfo {
    if (params !== undefined) {
      throw new JsonRpcError(-32602, 'Invalid params')
    }

    return this.systemService.getInfo()
  }
}
