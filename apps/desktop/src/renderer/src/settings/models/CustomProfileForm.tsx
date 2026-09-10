import type {
  CredentialSource,
  ModelProfile,
  SupportedCustomProviderApi,
  ThinkingLevel
} from '@folio/agent/config/schema'
import { Button } from '@folio/ui/components/ui/button'
import { DialogFooter } from '@folio/ui/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@folio/ui/components/ui/field'
import { Input } from '@folio/ui/components/ui/input'
import { useId, useRef, useState } from 'react'
import { modelSettingsMessages, type ModelSettingsLocale } from './messages'

const thinkingLevels: ReadonlyArray<ThinkingLevel> = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const providerApis: ReadonlyArray<SupportedCustomProviderApi> = ['openai-completions', 'anthropic-messages']
const credentialSources: ReadonlyArray<CredentialSource> = ['managed', 'environment', 'none']
const environmentVariablePattern = /^[A-Za-z_][A-Za-z0-9_]*$/

type FieldName = 'name' | 'id' | 'providerId' | 'baseUrl' | 'modelId' | 'displayName' | 'contextWindow' | 'maxTokens' | 'environmentVariable'

type Props = {
  locale: ModelSettingsLocale
  profile?: ModelProfile
  providerId?: string
  onSave: (profile: ModelProfile) => Promise<void>
  onClose: () => void
}

function isAbsoluteHttpsUrl(value: string): boolean {
  try { return new URL(value).protocol === 'https:' }
  catch { return false }
}

/** Edits the RFC-approved non-sensitive custom-provider fields without arbitrary JSON or headers. */
export function CustomProfileForm({ locale, profile, providerId: initialProviderId, onSave, onClose }: Props): React.JSX.Element {
  const text = modelSettingsMessages[locale]
  const id = useId()
  const customProvider = profile?.provider.type === 'custom' ? profile.provider : undefined
  const customModel = profile?.provider.type === 'custom' ? profile.customModel : undefined
  const [name, setName] = useState(profile?.name ?? '')
  const [profileId, setProfileId] = useState(profile?.id ?? '')
  const [providerId, setProviderId] = useState(customProvider?.providerId ?? initialProviderId ?? '')
  const [baseUrl, setBaseUrl] = useState(customProvider?.baseUrl ?? '')
  const [api, setApi] = useState<SupportedCustomProviderApi>(customProvider?.api ?? 'openai-completions')
  const [modelId, setModelId] = useState(profile?.modelId ?? '')
  const [displayName, setDisplayName] = useState(customModel?.displayName ?? '')
  const [reasoning, setReasoning] = useState(customModel?.reasoning ?? false)
  const [contextWindow, setContextWindow] = useState(customModel === undefined ? '128000' : String(customModel.contextWindow))
  const [maxTokens, setMaxTokens] = useState(customModel === undefined ? '4096' : String(customModel.maxTokens))
  const [credentialSource, setCredentialSource] = useState<CredentialSource>(profile?.credentialSource ?? 'managed')
  const [environmentVariable, setEnvironmentVariable] = useState(profile?.environmentVariable ?? '')
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(profile?.thinkingLevel ?? 'medium')
  const [invalid, setInvalid] = useState<FieldName[]>([])
  const [failed, setFailed] = useState(false)
  const [pending, setPending] = useState(false)
  const inFlight = useRef(false)

  const clearInvalid = (field: FieldName): void => setInvalid((current) => current.filter((entry) => entry !== field))

  async function submit(): Promise<void> {
    if (inFlight.current) return
    const parsedContextWindow = Number(contextWindow)
    const parsedMaxTokens = Number(maxTokens)
    const invalidFields: FieldName[] = []
    if (!name.trim()) invalidFields.push('name')
    if (!profileId.trim()) invalidFields.push('id')
    if (!providerId.trim()) invalidFields.push('providerId')
    if (!isAbsoluteHttpsUrl(baseUrl)) invalidFields.push('baseUrl')
    if (!modelId.trim()) invalidFields.push('modelId')
    if (!displayName.trim()) invalidFields.push('displayName')
    if (!Number.isInteger(parsedContextWindow) || parsedContextWindow <= 0) invalidFields.push('contextWindow')
    if (!Number.isInteger(parsedMaxTokens) || parsedMaxTokens <= 0 || parsedMaxTokens > parsedContextWindow) invalidFields.push('maxTokens')
    if (credentialSource === 'environment' && !environmentVariablePattern.test(environmentVariable)) invalidFields.push('environmentVariable')
    setInvalid(invalidFields)
    if (invalidFields.length > 0) return

    const nextProfile: ModelProfile = {
      id: profileId.trim(),
      name: name.trim(),
      provider: { type: 'custom', providerId: providerId.trim(), baseUrl, api },
      modelId: modelId.trim(),
      thinkingLevel,
      credentialSource,
      ...(credentialSource === 'environment' ? { environmentVariable } : {}),
      customModel: {
        displayName: displayName.trim(),
        reasoning,
        contextWindow: parsedContextWindow,
        maxTokens: parsedMaxTokens
      }
    }

    inFlight.current = true
    setPending(true)
    setFailed(false)
    try {
      await onSave(nextProfile)
      onClose()
    } catch {
      setFailed(true)
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }

  return (
    <form noValidate className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <FieldGroup className="gap-3">
        <Field data-invalid={invalid.includes('name')} data-disabled={pending}>
          <FieldLabel htmlFor={`${id}-name`}>{text.profileName}</FieldLabel>
          <Input id={`${id}-name`} value={name} disabled={pending} autoComplete="off" onChange={(event) => { setName(event.target.value); clearInvalid('name') }} aria-invalid={invalid.includes('name')} />
          {invalid.includes('name') ? <FieldError>{text.required}</FieldError> : null}
        </Field>
        <Field data-invalid={invalid.includes('id')} data-disabled={pending}>
          <FieldLabel htmlFor={`${id}-profile-id`}>{text.profileId}</FieldLabel>
          <Input id={`${id}-profile-id`} value={profileId} disabled={pending || profile !== undefined} autoComplete="off" spellCheck={false} onChange={(event) => { setProfileId(event.target.value); clearInvalid('id') }} aria-invalid={invalid.includes('id')} />
          {invalid.includes('id') ? <FieldError>{text.required}</FieldError> : null}
        </Field>
        <Field data-invalid={invalid.includes('providerId')} data-disabled={pending}>
          <FieldLabel htmlFor={`${id}-provider-id`}>{text.providerId}</FieldLabel>
          <Input id={`${id}-provider-id`} value={providerId} disabled={pending} autoComplete="off" spellCheck={false} onChange={(event) => { setProviderId(event.target.value); clearInvalid('providerId') }} aria-invalid={invalid.includes('providerId')} />
          {invalid.includes('providerId') ? <FieldError>{text.required}</FieldError> : null}
        </Field>
        <Field data-invalid={invalid.includes('baseUrl')} data-disabled={pending}>
          <FieldLabel htmlFor={`${id}-base-url`}>{text.baseUrl}</FieldLabel>
          <Input id={`${id}-base-url`} type="url" value={baseUrl} disabled={pending} autoComplete="off" spellCheck={false} placeholder="https://api.example.com/v1" onChange={(event) => { setBaseUrl(event.target.value); clearInvalid('baseUrl') }} aria-invalid={invalid.includes('baseUrl')} />
          {invalid.includes('baseUrl') ? <FieldError>{text.httpsRequired}</FieldError> : <FieldDescription>{text.httpsOnly}</FieldDescription>}
        </Field>
        <Field data-disabled={pending}>
          <FieldLabel htmlFor={`${id}-api`}>{text.providerApi}</FieldLabel>
          <select id={`${id}-api`} className="h-7 w-full rounded-md border border-input bg-background px-2 text-ui" value={api} disabled={pending} onChange={(event) => setApi(event.target.value as SupportedCustomProviderApi)}>
            {providerApis.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </Field>
        <Field data-invalid={invalid.includes('modelId')} data-disabled={pending}>
          <FieldLabel htmlFor={`${id}-model-id`}>{text.customModelId}</FieldLabel>
          <Input id={`${id}-model-id`} value={modelId} disabled={pending} autoComplete="off" spellCheck={false} onChange={(event) => { setModelId(event.target.value); clearInvalid('modelId') }} aria-invalid={invalid.includes('modelId')} />
          {invalid.includes('modelId') ? <FieldError>{text.required}</FieldError> : null}
        </Field>
        <Field data-invalid={invalid.includes('displayName')} data-disabled={pending}>
          <FieldLabel htmlFor={`${id}-display-name`}>{text.modelDisplayName}</FieldLabel>
          <Input id={`${id}-display-name`} value={displayName} disabled={pending} autoComplete="off" onChange={(event) => { setDisplayName(event.target.value); clearInvalid('displayName') }} aria-invalid={invalid.includes('displayName')} />
          {invalid.includes('displayName') ? <FieldError>{text.required}</FieldError> : null}
        </Field>
        <Field orientation="horizontal" data-disabled={pending}>
          <input id={`${id}-reasoning`} type="checkbox" checked={reasoning} disabled={pending} onChange={(event) => setReasoning(event.target.checked)} />
          <FieldLabel htmlFor={`${id}-reasoning`}>{text.reasoningModel}</FieldLabel>
        </Field>
        <Field data-invalid={invalid.includes('contextWindow')} data-disabled={pending}>
          <FieldLabel htmlFor={`${id}-context-window`}>{text.contextWindow}</FieldLabel>
          <Input id={`${id}-context-window`} type="number" min="1" step="1" value={contextWindow} disabled={pending} onChange={(event) => { setContextWindow(event.target.value); clearInvalid('contextWindow'); clearInvalid('maxTokens') }} aria-invalid={invalid.includes('contextWindow')} />
          {invalid.includes('contextWindow') ? <FieldError>{text.positiveIntegerRequired}</FieldError> : null}
        </Field>
        <Field data-invalid={invalid.includes('maxTokens')} data-disabled={pending}>
          <FieldLabel htmlFor={`${id}-max-tokens`}>{text.maxTokens}</FieldLabel>
          <Input id={`${id}-max-tokens`} type="number" min="1" step="1" value={maxTokens} disabled={pending} onChange={(event) => { setMaxTokens(event.target.value); clearInvalid('maxTokens') }} aria-invalid={invalid.includes('maxTokens')} />
          {invalid.includes('maxTokens') ? <FieldError>{text.maxTokensInvalid}</FieldError> : null}
        </Field>
        <Field data-disabled={pending}>
          <FieldLabel htmlFor={`${id}-credential-source`}>{text.credentialSource}</FieldLabel>
          <select id={`${id}-credential-source`} className="h-7 w-full rounded-md border border-input bg-background px-2 text-ui" value={credentialSource} disabled={pending} onChange={(event) => { setCredentialSource(event.target.value as CredentialSource); clearInvalid('environmentVariable') }}>
            {credentialSources.map((value) => <option key={value} value={value}>{text.credentialSources[value]}</option>)}
          </select>
        </Field>
        {credentialSource === 'environment' ? (
          <Field data-invalid={invalid.includes('environmentVariable')} data-disabled={pending}>
            <FieldLabel htmlFor={`${id}-environment-variable`}>{text.environmentVariable}</FieldLabel>
            <Input id={`${id}-environment-variable`} value={environmentVariable} disabled={pending} autoComplete="off" spellCheck={false} placeholder="OPENAI_API_KEY" onChange={(event) => { setEnvironmentVariable(event.target.value); clearInvalid('environmentVariable') }} aria-invalid={invalid.includes('environmentVariable')} />
            {invalid.includes('environmentVariable') ? <FieldError>{text.environmentVariableInvalid}</FieldError> : null}
          </Field>
        ) : null}
        <Field data-disabled={pending}>
          <FieldLabel htmlFor={`${id}-thinking`}>{text.thinkingLevel}</FieldLabel>
          <select id={`${id}-thinking`} className="h-7 w-full rounded-md border border-input bg-background px-2 text-ui" value={thinkingLevel} disabled={pending} onChange={(event) => setThinkingLevel(event.target.value as ThinkingLevel)}>
            {thinkingLevels.map((level) => <option key={level} value={level}>{level}</option>)}
          </select>
        </Field>
      </FieldGroup>
      {failed ? <FieldError>{text.operationFailed}</FieldError> : null}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={pending} onClick={onClose}>{text.cancel}</Button>
        <Button type="submit" disabled={pending}>{pending ? text.saving : text.save}</Button>
      </DialogFooter>
    </form>
  )
}
