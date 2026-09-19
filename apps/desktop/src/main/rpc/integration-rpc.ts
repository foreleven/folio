import { Effect } from 'effect'
import { IntegrationRpcs } from '../../shared/rpc/integration-rpc'
import { IntegrationService } from '../services/integrations/integration-service'

/** RPC acknowledges job scheduling; state changes continue over the shared watch stream. */
export const IntegrationRpcHandlersLive = IntegrationRpcs.toLayer(Effect.gen(function*() {
  const service = yield* IntegrationService
  return IntegrationRpcs.of({
    'integrations.watch': () => service.watch,
    'integrations.install': ({ id }) => service.install(id),
    'integrations.inspect': ({ id }) => service.inspect(id),
    'integrations.action': ({ id, actionId, payload }) => service.action(id, actionId, payload),
  })
}))
