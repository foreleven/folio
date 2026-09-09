import { useAtomRefresh, useAtomSet, useAtomValue } from '@effect/atom-react'
import { Button } from '@folio/ui/components/ui/button'
import { Skeleton } from '@folio/ui/components/ui/skeleton'
import { useRef, useState } from 'react'
import { useLocale } from '../../preferences'
import { IntegrationRpcClient, integrationsAtom } from '../../rpc/integration-rpc'
import { IntegrationCard } from './IntegrationCard'
import { integrationMessages } from './messages'

/** Connects a single push subscription to the catalog and submits explicit setup actions. */
export function IntegrationsSettings(): React.JSX.Element {
  const locale = useLocale()
  const text = integrationMessages[locale]
  const result = useAtomValue(integrationsAtom)
  const refresh = useAtomRefresh(integrationsAtom)
  const install = useAtomSet(IntegrationRpcClient.install, { mode: 'promise' })
  const inspect = useAtomSet(IntegrationRpcClient.inspect, { mode: 'promise' })
  const action = useAtomSet(IntegrationRpcClient.action, { mode: 'promise' })
  const inFlight = useRef(new Set<string>())
  const [pending, setPending] = useState<string[]>([])
  const [errors, setErrors] = useState<string[]>([])
  /** Prevents duplicate clicks until main acknowledges ownership; background progress comes from the stream. */
  async function submit(id: string, operation: () => Promise<unknown>): Promise<void> {
    if (inFlight.current.has(id)) return
    inFlight.current.add(id)
    setPending([...inFlight.current])
    setErrors((current) => current.filter((entry) => entry !== id))
    try { await operation() } catch (error) { setErrors((current) => [...current, id]); throw error }
    finally { inFlight.current.delete(id); setPending([...inFlight.current]) }
  }
  if (result._tag === 'Failure') return (
    <div role="alert" className="p-3"><p className="mb-3 text-ui">{text.loadFailed}</p><Button variant="outline" onClick={refresh}>{text.retry}</Button></div>
  )
  if (result._tag !== 'Success') return <div role="status" aria-label={text.loading}><Skeleton className="h-16 w-full rounded-md" /></div>
  return (
    <section aria-label={text.available} className="@container/integrations">
      <div className="flex flex-col gap-1">
      {result.value.map((integration) => (
        <IntegrationCard key={integration.id} integration={integration} locale={locale} pending={pending.includes(integration.id)} error={errors.includes(integration.id)}
          onInstall={() => { void submit(integration.id, () => install({ payload: { id: integration.id } })).catch(() => undefined) }}
          onInspect={() => { void submit(integration.id, () => inspect({ payload: { id: integration.id } })).catch(() => undefined) }}
          onAction={(actionId, payload) => submit(integration.id, () => action({ payload: { id: integration.id, actionId, payload } }))}
        />
      ))}
      </div>
    </section>
  )
}
