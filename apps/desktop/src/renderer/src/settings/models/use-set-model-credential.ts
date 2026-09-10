import { useAtomValue } from '@effect/atom-react'
import { Context, Effect, Redacted } from 'effect'
import type { ModelSettingsView } from '../../../../shared/model'
import { ModelRpcClient } from '../../rpc/model-rpc'

/**
 * Returns an imperative credential command without creating an Atom mutation.
 * The secret exists only in the caller's local input state and the single RPC request.
 */
export function useSetModelCredential(): (
  profileId: string,
  credential: string
) => Promise<ModelSettingsView> {
  const runtime = useAtomValue(ModelRpcClient.runtime)

  return async (profileId, credential) => {
    if (runtime._tag !== 'Success') throw new Error('Model RPC is unavailable')
    const client = Context.get(runtime.value, ModelRpcClient)
    return Effect.runPromise(client('models.setCredential', {
      profileId,
      credential: Redacted.make(credential)
    }))
  }
}
