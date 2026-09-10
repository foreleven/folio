import type { ModelProfile } from '@folio/agent/config/schema'
import { Button } from '@folio/ui/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@folio/ui/components/ui/dialog'
import { Input } from '@folio/ui/components/ui/input'
import { useRef, useState } from 'react'
import { modelSettingsMessages, type ModelSettingsLocale } from './messages'
import { useSetModelCredential } from './use-set-model-credential'

type Props = {
  profile: ModelProfile | null
  locale: ModelSettingsLocale
  onClose: () => void
  onFailure: () => void
}

/** Owns the only renderer secret state; successful submission clears and unmounts it. */
export function CredentialDialog({ profile, locale, onClose, onFailure }: Props): React.JSX.Element {
  const text = modelSettingsMessages[locale]
  const setCredential = useSetModelCredential()
  const [credential, setCredentialValue] = useState('')
  const [required, setRequired] = useState(false)
  const [saving, setSaving] = useState(false)
  const inFlight = useRef(false)

  function close(): void {
    if (inFlight.current) return
    setCredentialValue('')
    setRequired(false)
    onClose()
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (profile === null || inFlight.current) return
    if (credential.length === 0) {
      setRequired(true)
      return
    }
    inFlight.current = true
    setSaving(true)
    setRequired(false)
    try {
      await setCredential(profile.id, credential)
      setCredentialValue('')
      onClose()
    } catch {
      setCredentialValue('')
      onFailure()
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  return (
    <Dialog open={profile !== null} onOpenChange={(open) => { if (!open) close() }}>
      {profile === null ? null : (
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{text.credentialTitle}</DialogTitle>
            <DialogDescription>{text.credentialDescription}</DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-3" onSubmit={(event) => { void submit(event) }}>
            <label className="flex flex-col gap-1 text-ui">
              <span>{text.credentialLabel}</span>
              <Input type="password" autoComplete="off" value={credential}
                aria-invalid={required || undefined}
                onChange={(event) => { setCredentialValue(event.target.value); setRequired(false) }} />
              {required ? <span className="text-support text-destructive">{text.required}</span> : null}
            </label>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={saving} onClick={close}>{text.cancel}</Button>
              <Button type="submit" disabled={saving}>{saving ? text.savingCredential : text.saveCredential}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      )}
    </Dialog>
  )
}
