import { useAtomRefresh, useAtomSet, useAtomValue } from '@effect/atom-react'
import { Alert, AlertDescription, AlertTitle } from '@folio/ui/components/ui/alert'
import { Button } from '@folio/ui/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldTitle } from '@folio/ui/components/ui/field'
import { Separator } from '@folio/ui/components/ui/separator'
import { Skeleton } from '@folio/ui/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@folio/ui/components/ui/toggle-group'
import { Schema } from 'effect'
import { useEffect, useRef, useState } from 'react'
import { GlobalConfigPatch, Language, Theme } from '../../shared/config'
import { useLocale } from './preferences'
import { configAtom, ConfigRpcClient } from './rpc/config-rpc'

const messages = {
  en: {
    title: 'Settings', subtitle: 'Make Folio feel like home.', general: 'General',
    theme: 'Appearance', themeDescription: 'Choose how Folio looks on this device.',
    language: 'Language', languageDescription: 'Choose the language used in Folio.',
    system: 'System', light: 'Light', dark: 'Dark',
    automatic: 'Changes are saved automatically.', saving: 'Saving…', saved: 'Saved',
    loading: 'Loading preferences…', retry: 'Try again',
    loadError: 'Couldn’t load preferences', loadDetail: 'Check your configuration file and try again.',
    saveError: 'Couldn’t save changes', saveDetail: 'Your previous preferences are still active. Please try again.'
  },
  'zh-CN': {
    title: '设置', subtitle: '让 Folio 更合你的习惯。', general: '通用',
    theme: '外观', themeDescription: '选择 Folio 在这台设备上的显示主题。',
    language: '语言', languageDescription: '选择 Folio 界面使用的语言。',
    system: '跟随系统', light: '浅色', dark: '深色',
    automatic: '更改会自动保存。', saving: '正在保存…', saved: '已保存',
    loading: '正在读取配置…', retry: '重试',
    loadError: '无法读取配置', loadDetail: '请检查配置文件后重试。',
    saveError: '无法保存更改', saveDetail: '之前的配置仍然有效，请重试。'
  }
}

/** Independent settings page; controlled inputs reflect only persisted server values. */
export function Settings(): React.JSX.Element {
  const locale = useLocale()
  const text = messages[locale]
  const config = useAtomValue(configAtom)
  const refresh = useAtomRefresh(configAtom)
  const update = useAtomSet(ConfigRpcClient.update, { mode: 'promise' })
  const saving = useRef(false)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  useEffect(() => { document.title = `${text.title} — Folio` }, [text.title])

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
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-7 p-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{text.title}</h1>
        <p className="text-sm text-muted-foreground">{text.subtitle}</p>
      </header>
      <Separator />
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
        <section aria-labelledby="general-title" className="flex flex-col gap-6">
          <h2 id="general-title" className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{text.general}</h2>
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
    </main>
  )
}
