import { Effect } from 'effect'
import { SystemRpcs } from '../../shared/rpc/system-rpc'
import { SystemService } from '../services/system-service'

/** Main-process handlers for the shared system RPC interface. */
export const SystemRpcHandlersLive = SystemRpcs.toLayer(
  Effect.gen(function*() {
    const system = yield* SystemService

    return SystemRpcs.of({
      /** Returns metadata through the process-owned Effect service. */
      'system.getInfo': () => system.getInfo
    })
  })
)
