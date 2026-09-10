import { useAtomValue } from '@effect/atom-react'
import { Context, Effect, Redacted } from 'effect'
import type { ModelSettingsView } from '../../../../shared/model'
import { ModelRpcClient } from '../../rpc/model-rpc'

/** Sends the key directly to RPC so a mutation atom never retains the secret payload. */
export function useSetProviderCredential(): (providerId: string, credential: string) => Promise<ModelSettingsView> {
  const runtime = useAtomValue(ModelRpcClient.runtime)
  return async (providerId, credential) => {
    if (runtime._tag !== 'Success') throw new Error('Model RPC is unavailable')
    const client = Context.get(runtime.value, ModelRpcClient)
    return Effect.runPromise(client('models.setProviderCredential', {
      providerId, credential: Redacted.make(credential, { label: 'provider credential' })
    }))
  }
}
