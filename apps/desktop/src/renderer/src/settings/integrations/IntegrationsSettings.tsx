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
  const check = useAtomSet(IntegrationRpcClient.check, { mode: 'promise' })
  const action = useAtomSet(IntegrationRpcClient.action, { mode: 'promise' })
  const open = useAtomSet(IntegrationRpcClient.openAuthorization, { mode: 'promise' })
  const inFlight = useRef(new Set<string>())
  const [pending, setPending] = useState<string[]>([])
  const [errors, setErrors] = useState<string[]>([])
  /** Prevents duplicate clicks until main acknowledges ownership; background progress comes from the stream. */
  async function submit(id: string, operation: () => Promise<unknown>): Promise<void> {
    if (inFlight.current.has(id)) return
    inFlight.current.add(id)
    setPending([...inFlight.current])
    setErrors((current) => current.filter((entry) => entry !== id))
    try { await operation() } catch { setErrors((current) => [...current, id]) }
    finally { inFlight.current.delete(id); setPending([...inFlight.current]) }
  }
  if (result._tag === 'Failure') return (
    <div role="alert" className="rounded-lg border p-5"><p className="mb-3 text-sm">{text.loadFailed}</p><Button variant="outline" onClick={refresh}>{text.retry}</Button></div>
  )
  if (result._tag !== 'Success') return <div role="status" aria-label={text.loading}><Skeleton className="h-64 w-full rounded-xl" /></div>
  return (
    <section aria-label={text.available} className="flex flex-col gap-4">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{text.available}</p>
      {result.value.map((integration) => (
        <IntegrationCard key={integration.id} integration={integration} locale={locale} pending={pending.includes(integration.id)} error={errors.includes(integration.id)}
          onInstall={() => { void submit(integration.id, () => install({ payload: { id: integration.id } })) }}
          onCheck={() => { void submit(integration.id, () => check({ payload: { id: integration.id } })) }}
          onAction={(actionId) => { void submit(integration.id, () => action({ payload: { id: integration.id, actionId } })) }}
          onOpenAuthorization={() => { void submit(integration.id, () => open({ payload: { id: integration.id } })) }}
        />
      ))}
    </section>
  )
}
