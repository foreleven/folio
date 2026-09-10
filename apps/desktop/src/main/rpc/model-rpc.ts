import { Effect } from 'effect'
import { ModelRpcs } from '../../shared/rpc/model-rpc'
import { ModelService } from '../services/model-service'

/** Routes renderer model commands through the main-process credential and config boundary. */
export const ModelRpcHandlersLive = ModelRpcs.toLayer(Effect.gen(function*() {
  const models = yield* ModelService
  return ModelRpcs.of({
    'models.setProviderCredential': ({ providerId, credential }) => models.setProviderCredential(providerId, credential),
    'models.watch': () => models.watch,
    'models.saveProfile': (profile) => models.saveProfile(profile),
    'models.deleteProfile': ({ profileId }) => models.deleteProfile(profileId),
    'models.setDefault': ({ profileId }) => models.setDefault(profileId),
    'models.setCredential': ({ profileId, credential }) => models.setCredential(profileId, credential),
    'models.deleteCredential': ({ profileId }) => models.deleteCredential(profileId),
    'models.listCatalog': () => models.listCatalog,
    'models.refreshCatalog': () => models.refreshCatalog,
    'models.testConnection': ({ profileId }) => models.testConnection(profileId),
    'models.rebuildDerivedConfig': () => models.rebuildDerivedConfig
  })
}))
