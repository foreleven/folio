import { Button } from '@folio/ui/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@folio/ui/components/ui/dialog'
import { Input } from '@folio/ui/components/ui/input'
import { useId, useRef, useState } from 'react'
import type { ModelCatalogEntry } from '../../../../shared/model'
import { modelSettingsMessages, type ModelSettingsLocale } from './messages'
import { ProviderModels } from './ProviderModels'
import { useSetProviderCredential } from './use-set-provider-credential'

/** Owns the provider/key draft, clearing secrets on provider changes, failure and unmount. */
export function AddProviderDialog({ catalog, locale, initialProviderId, onClose, onSaved }: {
  catalog: readonly ModelCatalogEntry[]
  locale: ModelSettingsLocale
  initialProviderId?: string
  onClose: () => void
  onSaved: (providerId: string) => void
}): React.JSX.Element {
  const text = modelSettingsMessages[locale]
  const id = useId()
  const providers = [...new Map(catalog.map((model) => [model.providerId, model.providerName])).entries()]
  const [providerId, setProviderId] = useState(initialProviderId ?? '')
  const [key, setKey] = useState('')
  const [required, setRequired] = useState(false)
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const inFlight = useRef(false)
  const setCredential = useSetProviderCredential()

  /** Guards duplicate submissions; only a successful credential write selects the new provider. */
  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (inFlight.current) return
    if (!providerId || !key.trim()) { setRequired(true); return }
    inFlight.current = true
    setSaving(true)
    setFailed(false)
    try {
      await setCredential(providerId, key.trim())
      setKey('')
      onSaved(providerId)
    } catch {
      setKey('')
      setFailed(true)
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !inFlight.current) { setKey(''); onClose() } }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader><DialogTitle>{text.addProfile}</DialogTitle><DialogDescription>{text.addProviderDescription}</DialogDescription></DialogHeader>
        <form className="flex min-h-0 flex-col gap-4" onSubmit={(event) => { void submit(event) }}>
          <label className="flex flex-col gap-1 text-ui" htmlFor={`${id}-provider`}>
            <span>{text.providerName}</span>
            <select id={`${id}-provider`} value={providerId} disabled={saving} aria-invalid={required && !providerId} className="h-8 w-full rounded-md border border-input bg-background px-2 text-ui" onChange={(event) => { setProviderId(event.target.value); setKey(''); setRequired(false); setFailed(false) }}>
              <option value="">{text.selectProvider}</option>
              {providers.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-ui" htmlFor={`${id}-key`}>
            <span>{text.credentialLabel}</span>
            <Input id={`${id}-key`} type="password" autoComplete="off" disabled={saving} value={key} aria-invalid={required && !key.trim()} onChange={(event) => { setKey(event.target.value); setRequired(false) }} />
          </label>
          {required ? <p role="alert" className="text-support text-destructive">{text.required}</p> : null}
          {failed ? <p role="alert" className="text-support text-destructive">{text.credentialOperationFailed}</p> : null}
          {providerId ? <ProviderModels models={catalog.filter((model) => model.providerId === providerId)} locale={locale} /> : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={() => { setKey(''); onClose() }}>{text.cancel}</Button>
            <Button type="submit" disabled={saving || providers.length === 0}>{saving ? text.savingCredential : text.addProfile}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
