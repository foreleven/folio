import { useId, useRef, useState } from 'react'
import { integrationText, type IntegrationActionDefinition } from '@folio/integrations/protocol'
import { Button } from '@folio/ui/components/ui/button'
import { DialogFooter } from '@folio/ui/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@folio/ui/components/ui/field'
import { Input } from '@folio/ui/components/ui/input'
import { integrationMessages } from './messages'

type Props = {
  action: IntegrationActionDefinition
  locale: 'en' | 'zh-CN'
  available: boolean
  onSubmit: (payload: Record<string, string>) => Promise<void>
  onClose: () => void
}

/** Holds credentials only in an unmounted-on-close form; failed submissions never echo server diagnostics. */
export function IntegrationActionForm({ action, locale, available, onSubmit, onClose }: Props): React.JSX.Element {
  const id = useId()
  const submitting = useRef(false)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [invalid, setInvalid] = useState<string[]>([])
  const text = integrationMessages[locale]
  /** Validates declared fields and submits only those values; duplicate events share one in-flight guard. */
  async function submit(form: HTMLFormElement): Promise<void> {
    if (submitting.current || !available) return
    const data = new FormData(form)
    const values = Object.fromEntries((action.fields ?? []).map((field) => [field.id, String(data.get(field.id) ?? '')]))
    const missing = (action.fields ?? []).filter((field) => field.required && !values[field.id]?.trim()).map((field) => field.id)
    setInvalid(missing)
    if (missing.length) {
      const field = form.elements.namedItem(missing[0])
      if (field instanceof HTMLElement) field.focus()
      return
    }
    submitting.current = true
    setPending(true)
    setFailed(false)
    try {
      await onSubmit(values)
      form.reset()
      onClose()
    } catch {
      // Reset secrets even on rejection. The user can retry, but stale credentials do not linger.
      form.reset()
      setFailed(true)
    } finally {
      submitting.current = false
      setPending(false)
    }
  }
  return (
    <form className="flex flex-col gap-4" noValidate onSubmit={(event) => { event.preventDefault(); void submit(event.currentTarget) }}>
      <FieldGroup className="gap-3">
        {(action.fields ?? []).map((field) => (
          <Field key={field.id} data-invalid={invalid.includes(field.id)} data-disabled={pending || !available}>
            <FieldLabel htmlFor={`${id}-${field.id}`}>{integrationText(field.label, locale)}{field.required ? <span aria-hidden="true">*</span> : null}</FieldLabel>
            <Input id={`${id}-${field.id}`} name={field.id} type={field.type} required={field.required}
              onChange={(event) => { if (event.target.value.trim()) setInvalid((current) => current.filter((id) => id !== field.id)) }}
              disabled={pending || !available} autoComplete="off" spellCheck={false}
              aria-invalid={invalid.includes(field.id)} aria-describedby={invalid.includes(field.id) ? `${id}-${field.id}-error` : field.description ? `${id}-${field.id}-description` : undefined} />
            {field.description ? <FieldDescription id={`${id}-${field.id}-description`}>{integrationText(field.description, locale)}</FieldDescription> : null}
            {invalid.includes(field.id) ? <FieldError id={`${id}-${field.id}-error`}>{text.required}</FieldError> : null}
          </Field>
        ))}
      </FieldGroup>
      {failed || !available ? <FieldError>{available ? text.failed : text.stale}</FieldError> : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>{text.cancel}</Button>
        <Button type="submit" disabled={pending || !available}>{pending ? text.working : text.submit}</Button>
      </DialogFooter>
    </form>
  )
}
