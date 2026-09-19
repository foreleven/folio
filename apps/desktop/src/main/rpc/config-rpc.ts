import { Effect } from 'effect'
import { ConfigRpcs } from '../../shared/rpc/config-rpc'
import { ConfigService } from '../services/config/config-service'

/** Both windows use the same main-process store, write lock, and change stream. */
export const ConfigRpcHandlersLive = ConfigRpcs.toLayer(Effect.gen(function*() {
  const config = yield* ConfigService
  return ConfigRpcs.of({
    'config.watch': () => config.watch,
    'config.update': (patch) => config.update(patch)
  })
}))
