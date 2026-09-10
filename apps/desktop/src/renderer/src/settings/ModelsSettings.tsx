import { useAtomRefresh, useAtomSet, useAtomValue } from '@effect/atom-react'
import { Alert, AlertDescription, AlertTitle } from '@folio/ui/components/ui/alert'
import { Button } from '@folio/ui/components/ui/button'
import { Skeleton } from '@folio/ui/components/ui/skeleton'
import { RefreshCwIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import { useLocale } from '../preferences'
import { modelCatalogAtom, ModelRpcClient, modelsAtom } from '../rpc/model-rpc'
import { AddProviderDialog } from './models/AddProviderDialog'
import { modelSettingsMessages } from './models/messages'
import { ProviderModels } from './models/ProviderModels'

/** Selects configured providers and displays their catalog; model profiles are not part of provider setup. */
export function ModelsSettings(): React.JSX.Element {
  const locale = useLocale()
  const text = modelSettingsMessages[locale]
  const models = useAtomValue(modelsAtom)
  const catalog = useAtomValue(modelCatalogAtom)
  const refreshModels = useAtomRefresh(modelsAtom)
  const refreshCatalogQuery = useAtomRefresh(modelCatalogAtom)
  const refreshCatalog = useAtomSet(ModelRpcClient.refreshCatalog, { mode: 'promise' })
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null)
  const [editor, setEditor] = useState<{ providerId?: string } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [failed, setFailed] = useState(false)
  const inFlight = useRef(false)

  /** Refreshes catalog explicitly, preserving the last available list if the request fails. */
  async function refresh(): Promise<void> {
    if (inFlight.current) return
    inFlight.current = true
    setRefreshing(true)
    setFailed(false)
    try { await refreshCatalog({ payload: undefined }); refreshCatalogQuery() }
    catch { setFailed(true) }
    finally { inFlight.current = false; setRefreshing(false) }
  }

  if (models._tag === 'Failure') return <Alert variant="destructive"><AlertTitle>{text.loadFailed}</AlertTitle><AlertDescription><Button variant="outline" onClick={refreshModels}>{text.retry}</Button></AlertDescription></Alert>
  if (models._tag !== 'Success') return <div role="status" aria-label={text.loading}><Skeleton className="h-24 w-full" /></div>

  const providers = [...new Set([
    ...(models.value.configuredProviders ?? []),
    ...models.value.profiles.map(({ profile }) => profile.provider.providerId)
  ])]
  const activeProvider = selectedProvider && providers.includes(selectedProvider) ? selectedProvider : providers[0]
  const entries = catalog._tag === 'Success' ? catalog.value.models : []
  const providerName = (providerId: string): string => entries.find((entry) => entry.providerId === providerId)?.providerName ?? providerId

  return (
    <section aria-label="Pi providers" className="flex flex-col gap-4">
      <div>
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-ui font-medium">Pi · Providers</h3>
          <Button disabled={catalog._tag !== 'Success' || entries.length === 0} onClick={() => setEditor({})}>{text.addProfile}</Button>
        </div>
        <p className="mt-2 text-support text-muted-foreground">{text.piImportDescription}</p>
      </div>
      {models.value.piImportFailed ? <Alert variant="destructive"><AlertTitle>{text.piImportFailed}</AlertTitle></Alert> : null}
      {failed ? <Alert variant="destructive"><AlertTitle>{text.catalogRefreshFailed}</AlertTitle></Alert> : null}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {providers.length === 0 ? <p className="rounded-xl border border-dashed p-6 text-center text-support text-muted-foreground">{text.noProviders}</p> : (
            <div className="flex flex-wrap gap-2" role="group" aria-label={text.selectProvider}>
              {providers.map((providerId) => {
                const selected = activeProvider === providerId
                return <Button key={providerId} variant="outline" aria-pressed={selected}
                  className={selected
                    ? 'border-primary/60 bg-primary/5 text-primary hover:bg-primary/10 hover:text-primary dark:border-primary/60 dark:bg-primary/10 dark:hover:bg-primary/15'
                    : 'text-muted-foreground'}
                  onClick={() => setSelectedProvider(providerId)}>
                  {providerName(providerId)}
                </Button>
              })}
            </div>
          )}
        </div>
        <Button variant="ghost" size="icon" disabled={refreshing} aria-label={refreshing ? text.refreshingCatalog : text.refreshCatalog} title={text.refreshCatalogDescription} onClick={() => { void refresh() }}>
          <RefreshCwIcon aria-hidden="true" className={refreshing ? 'animate-spin motion-reduce:animate-none' : ''} />
        </Button>
      </div>
      {catalog._tag === 'Failure' ? <Alert variant="destructive"><AlertTitle>{text.catalogFailed}</AlertTitle><AlertDescription><Button variant="outline" onClick={refreshCatalogQuery}>{text.retry}</Button></AlertDescription></Alert>
        : catalog._tag !== 'Success' ? <div role="status" aria-label={text.catalogLoading}><Skeleton className="h-24 w-full" /></div>
        : activeProvider ? (
          <div className="flex flex-col gap-3 rounded-xl border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div><p className="text-ui font-medium">{providerName(activeProvider)}</p><p className="text-support text-muted-foreground">{(models.value.configuredProviders ?? []).includes(activeProvider) ? text.credentialReady : text.credentialMissing}</p></div>
              <Button variant="outline" size="sm" disabled={!entries.some((entry) => entry.providerId === activeProvider)} onClick={() => setEditor({ providerId: activeProvider })}>{text.configureCredential}</Button>
            </div>
            {catalog.value.stale ? <p className="text-support text-muted-foreground">{text.catalogStale}</p> : null}
            <ProviderModels models={entries.filter((entry) => entry.providerId === activeProvider)} locale={locale} />
          </div>
        ) : null}
      {editor !== null && catalog._tag === 'Success' ? <AddProviderDialog catalog={catalog.value.models} locale={locale} initialProviderId={editor.providerId} onClose={() => setEditor(null)} onSaved={(providerId) => { setSelectedProvider(providerId); setEditor(null); refreshModels() }} /> : null}
    </section>
  )
}
