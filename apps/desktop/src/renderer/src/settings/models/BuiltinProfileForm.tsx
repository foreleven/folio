import type { ModelProfile, ThinkingLevel } from '@folio/agent/config/schema'
import { Button } from '@folio/ui/components/ui/button'
import { DialogFooter } from '@folio/ui/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@folio/ui/components/ui/field'
import { Input } from '@folio/ui/components/ui/input'
import { useId, useRef, useState } from 'react'
import type { ModelCatalogEntry } from '../../../../shared/model'
import { modelSettingsMessages, type ModelSettingsLocale } from './messages'

const thinkingLevels: ReadonlyArray<ThinkingLevel> = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

type Props = {
  locale: ModelSettingsLocale
  catalog: ReadonlyArray<ModelCatalogEntry>
  profile?: ModelProfile
  providerId?: string
  onSave: (profile: ModelProfile) => Promise<void>
  onClose: () => void
}

/** Edits a non-sensitive built-in profile draft; committed state continues to come from models.watch. */
export function BuiltinProfileForm({ locale, catalog, profile, providerId, onSave, onClose }: Props): React.JSX.Element {
  const text = modelSettingsMessages[locale]
  const id = useId()
  const builtin = catalog.filter(({ source }) => source === 'builtin')
  const initialIndex = profile?.provider.type === 'builtin'
    ? builtin.findIndex(({ providerId, modelId }) => providerId === profile.provider.providerId && modelId === profile.modelId)
    : providerId ? builtin.findIndex((entry) => entry.providerId === providerId) : (builtin.length > 0 ? 0 : -1)
  const [selectedProvider, setSelectedProvider] = useState(profile?.provider.providerId ?? providerId ?? builtin[0]?.providerId ?? '')
  const providers = [...new Map(builtin.map((entry) => [entry.providerId, entry.providerName])).entries()]
  const [name, setName] = useState(profile?.name ?? '')
  const [profileId, setProfileId] = useState(profile?.id ?? '')
  const [model, setModel] = useState(initialIndex < 0 ? '' : String(initialIndex))
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(profile?.thinkingLevel ?? 'medium')
  const [invalid, setInvalid] = useState<string[]>([])
  const [failed, setFailed] = useState(false)
  const [pending, setPending] = useState(false)
  const inFlight = useRef(false)

  async function submit(): Promise<void> {
    if (inFlight.current) return
    const missing = [!profileId.trim() ? 'id' : '', !name.trim() ? 'name' : '', !model ? 'model' : ''].filter(Boolean)
    setInvalid(missing)
    if (missing.length) return
    const entry = builtin[Number(model)]
    if (!entry) { setInvalid(['model']); return }
    inFlight.current = true
    setPending(true)
    setFailed(false)
    try {
      await onSave({
        id: profileId.trim(),
        name: name.trim(),
        provider: { type: 'builtin', providerId: entry.providerId },
        modelId: entry.modelId,
        thinkingLevel,
        credentialSource: profile?.credentialSource ?? 'managed',
        ...(profile?.environmentVariable === undefined ? {} : { environmentVariable: profile.environmentVariable })
      })
      onClose()
    } catch {
      setFailed(true)
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }

  return (
    <form noValidate className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <FieldGroup className="gap-3">
        <Field data-invalid={invalid.includes('name')} data-disabled={pending}>
          <FieldLabel htmlFor={`${id}-name`}>{text.profileName}</FieldLabel>
          <Input id={`${id}-name`} value={name} disabled={pending} autoComplete="off" onChange={(event) => { setName(event.target.value); setInvalid((current) => current.filter((field) => field !== 'name')) }} aria-invalid={invalid.includes('name')} />
          {invalid.includes('name') ? <FieldError>{text.required}</FieldError> : null}
        </Field>
        <Field data-invalid={invalid.includes('id')} data-disabled={pending}>
          <FieldLabel htmlFor={`${id}-profile-id`}>{text.profileId}</FieldLabel>
          <Input id={`${id}-profile-id`} value={profileId} disabled={pending || profile !== undefined} autoComplete="off" spellCheck={false} onChange={(event) => { setProfileId(event.target.value); setInvalid((current) => current.filter((field) => field !== 'id')) }} aria-invalid={invalid.includes('id')} />
          {invalid.includes('id') ? <FieldError>{text.required}</FieldError> : null}
        </Field>
        <Field data-disabled={pending}>
          <FieldLabel htmlFor={`${id}-provider`}>Provider</FieldLabel>
          <select id={`${id}-provider`} className="h-7 w-full rounded-md border border-input bg-background px-2 text-ui" value={selectedProvider} disabled={pending} onChange={(event) => {
            setSelectedProvider(event.target.value)
            const index = builtin.findIndex((entry) => entry.providerId === event.target.value)
            setModel(index < 0 ? '' : String(index))
          }}>
            {providers.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
          </select>
        </Field>
        <Field data-invalid={invalid.includes('model')} data-disabled={pending || builtin.length === 0}>
          <FieldLabel htmlFor={`${id}-model`}>{text.builtinModel}</FieldLabel>
          <select id={`${id}-model`} className="h-7 w-full rounded-md border border-input bg-background px-2 text-ui" value={model} disabled={pending || builtin.length === 0} onChange={(event) => { setModel(event.target.value); setInvalid((current) => current.filter((field) => field !== 'model')) }} aria-invalid={invalid.includes('model')}>
            {builtin.length === 0 ? <option value="">{text.catalogFailed}</option> : null}
            {builtin.map((entry, index) => entry.providerId === selectedProvider ? <option key={`${entry.providerId}/${entry.modelId}`} value={String(index)}>{entry.providerName} · {entry.modelName}</option> : null)}
          </select>
          {invalid.includes('model') ? <FieldError>{text.required}</FieldError> : null}
        </Field>
        <Field data-disabled={pending}>
          <FieldLabel htmlFor={`${id}-thinking`}>{text.thinkingLevel}</FieldLabel>
          <select id={`${id}-thinking`} className="h-7 w-full rounded-md border border-input bg-background px-2 text-ui" value={thinkingLevel} disabled={pending} onChange={(event) => setThinkingLevel(event.target.value as ThinkingLevel)}>
            {thinkingLevels.map((level) => <option key={level} value={level}>{level}</option>)}
          </select>
        </Field>
      </FieldGroup>
      {failed ? <FieldError>{text.operationFailed}</FieldError> : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>{text.cancel}</Button>
        <Button type="submit" disabled={pending || builtin.length === 0}>{pending ? text.saving : text.save}</Button>
      </DialogFooter>
    </form>
  )
}
