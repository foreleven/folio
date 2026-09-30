import { useAtomValue } from '@effect/atom-react'
import type { SystemOneConfig } from '@folio/agent/config/schema'
import { Context, Effect, Redacted } from 'effect'
import type { ModelSettingsView } from '../../../../shared/model'
import { ModelRpcClient } from '../../rpc/model-rpc'

/** Send a one-shot credential directly to RPC; no mutation atom retains its payload. */
export function useSaveSystemOne(): (configuration: SystemOneConfig, apiKey: string) => Promise<ModelSettingsView> {
  const runtime = useAtomValue(ModelRpcClient.runtime)
  return async (configuration, apiKey) => {
    if (runtime._tag !== 'Success') throw new Error('Model RPC is unavailable')
    return Effect.runPromise(Context.get(runtime.value, ModelRpcClient)('models.saveSystemOne', {
      configuration, ...(apiKey ? { apiKey: Redacted.make(apiKey, { label: 'System One credential' }) } : {})
    }))
  }
}
