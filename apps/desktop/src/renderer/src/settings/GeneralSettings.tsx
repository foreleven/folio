import { useAtomRefresh, useAtomSet, useAtomValue } from '@effect/atom-react'
import { Alert, AlertDescription, AlertTitle } from '@folio/ui/components/ui/alert'
import { Button } from '@folio/ui/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldTitle } from '@folio/ui/components/ui/field'
import { Skeleton } from '@folio/ui/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@folio/ui/components/ui/toggle-group'
import { Schema } from 'effect'
import { useRef, useState } from 'react'
import { GlobalConfigPatch, Language, Theme } from '../../../shared/config'
import { useLocale } from '../preferences'
import { configAtom, ConfigRpcClient } from '../rpc/config-rpc'
import { settingsMessages } from './messages'

/** General preferences; controlled inputs reflect only persisted server values. */
export function GeneralSettings(): React.JSX.Element {
  const locale = useLocale()
  const text = settingsMessages[locale]
  const config = useAtomValue(configAtom)
  const refresh = useAtomRefresh(configAtom)
  const update = useAtomSet(ConfigRpcClient.update, { mode: 'promise' })
  const saving = useRef(false)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  /** Blocks overlapping UI submissions and exposes failures without optimistic false success. */
  async function save(patch: GlobalConfigPatch): Promise<void> {
    if (saving.current) return
    saving.current = true
    setStatus('saving')
    try {
      await update({ payload: patch })
      setStatus('saved')
    } catch {
      setStatus('error')
    } finally {
      saving.current = false
    }
  }

  return (
    <>
      {config._tag === 'Failure' ? (
        <Alert variant="destructive">
          <AlertTitle>{text.loadError}</AlertTitle>
          <AlertDescription>{text.loadDetail}</AlertDescription>
          <Button variant="outline" onClick={refresh} className="mt-3 w-fit">{text.retry}</Button>
        </Alert>
      ) : config._tag !== 'Success' ? (
        <div role="status" aria-label={text.loading} className="flex flex-col gap-5">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : (
        <section aria-label={text.general} className="flex flex-col gap-6">
          <FieldGroup>
            <Field data-disabled={status === 'saving'}>
              <FieldTitle id="theme-label">{text.theme}</FieldTitle>
              <FieldDescription id="theme-description">{text.themeDescription}</FieldDescription>
              <ToggleGroup
                aria-labelledby="theme-label"
                aria-describedby="theme-description"
                variant="outline"
                size="lg"
                value={[config.value.theme]}
                disabled={status === 'saving'}
                onValueChange={(values) => {
                  const value = values[0]
                  if (Schema.is(Theme)(value) && value !== config.value.theme) void save({ theme: value })
                }}
              >
                <ToggleGroupItem value="system">{text.system}</ToggleGroupItem>
                <ToggleGroupItem value="light">{text.light}</ToggleGroupItem>
                <ToggleGroupItem value="dark">{text.dark}</ToggleGroupItem>
              </ToggleGroup>
            </Field>
            <Field data-disabled={status === 'saving'}>
              <FieldTitle id="language-label">{text.language}</FieldTitle>
              <FieldDescription id="language-description">{text.languageDescription}</FieldDescription>
              <ToggleGroup
                aria-labelledby="language-label"
                aria-describedby="language-description"
                variant="outline"
                size="lg"
                value={[config.value.language]}
                disabled={status === 'saving'}
                onValueChange={(values) => {
                  const value = values[0]
                  if (Schema.is(Language)(value) && value !== config.value.language) void save({ language: value })
                }}
              >
                <ToggleGroupItem value="system">{text.system}</ToggleGroupItem>
                <ToggleGroupItem value="zh-CN">简体中文</ToggleGroupItem>
                <ToggleGroupItem value="en">English</ToggleGroupItem>
              </ToggleGroup>
            </Field>
          </FieldGroup>
          {status === 'error' ? (
            <Alert variant="destructive">
              <AlertTitle>{text.saveError}</AlertTitle>
              <AlertDescription>{text.saveDetail}</AlertDescription>
            </Alert>
          ) : null}
          <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
            {status === 'saving' ? text.saving : status === 'saved' ? text.saved : text.automatic}
          </p>
        </section>
      )}
    </>
  )
}
