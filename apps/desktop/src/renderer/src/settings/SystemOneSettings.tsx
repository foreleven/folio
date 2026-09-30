import { useAtomValue } from '@effect/atom-react'
import { Button } from '@folio/ui/components/ui/button'
import { Input } from '@folio/ui/components/ui/input'
import { SystemOneConfig } from '@folio/agent/config/schema'
import { Schema } from 'effect'
import { useRef, useState } from 'react'
import { useLocale } from '../preferences'
import { modelsAtom } from '../rpc/model-rpc'
import { useSaveSystemOne } from './models/use-save-system-one'
import type { ModelSettingsView } from '../../../shared/model'

/** One-shot credential input; neither a mutation atom nor watch state retains the API key. */
export function SystemOneSettings(): React.JSX.Element {
  const settings = useAtomValue(modelsAtom)
  const chinese = useLocale() === 'zh-CN'
  return <section aria-label="System One" className="flex flex-col gap-3 border-t pt-5">
    <div><h3 className="text-ui font-medium">System One</h3>
      <p className="text-support text-muted-foreground">{chinese ? '配置用于判断原始资料是否命中知识目标的服务。' : 'Configure the service that matches raw material against knowledge goals.'}</p></div>
    {settings._tag === 'Success' ? <SystemOneForm key={JSON.stringify(settings.value.systemOne?.configuration)} value={settings.value.systemOne} />
      : <p role="status" className="text-support text-muted-foreground">{settings._tag === 'Failure'
        ? chinese ? '无法读取配置' : 'Could not load settings' : chinese ? '正在读取配置…' : 'Loading settings…'}</p>}
  </section>
}

function SystemOneForm({ value }: { value: ModelSettingsView['systemOne'] }): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const saveConfiguration = useSaveSystemOne()
  const [baseUrl, setBaseUrl] = useState(value?.configuration.baseUrl ?? '')
  const [model, setModel] = useState(value?.configuration.model ?? '')
  const [apiKey, setApiKey] = useState('')
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const saving = useRef(false)
  const valid = Schema.is(SystemOneConfig)({ baseUrl: baseUrl.trim(), model: model.trim() }) && (value?.credentialConfigured || !!apiKey.trim())

  async function save(): Promise<void> {
    if (saving.current || !valid) return
    saving.current = true
    setStatus('saving')
    try {
      await saveConfiguration({ baseUrl: baseUrl.trim(), model: model.trim() }, apiKey.trim())
      setStatus('saved')
    } catch { setStatus('failed') }
    finally { setApiKey(''); saving.current = false }
  }

  return <form className="flex max-w-xl flex-col gap-3" onSubmit={event => { event.preventDefault(); void save() }}>
    <label className="flex flex-col gap-1 text-support">Base URL
      <Input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="http://localhost:8000/v1" disabled={status === 'saving'} required />
    </label>
    <label className="flex flex-col gap-1 text-support">{chinese ? '模型' : 'Model'}
      <Input value={model} onChange={event => setModel(event.target.value)} placeholder="jev-latest" disabled={status === 'saving'} required />
    </label>
    <label className="flex flex-col gap-1 text-support">API key
      <Input type="password" autoComplete="new-password" value={apiKey} onChange={event => setApiKey(event.target.value)}
        placeholder={value?.credentialConfigured ? chinese ? '已配置；留空保留现有密钥' : 'Configured; leave empty to keep the current key' : ''} disabled={status === 'saving'} />
    </label>
    <Button type="submit" className="w-fit" disabled={!valid || status === 'saving'}>
      {status === 'saving' ? chinese ? '正在保存…' : 'Saving…' : chinese ? '保存' : 'Save'}
    </Button>
    {status === 'saved' ? <p role="status" className="text-support text-muted-foreground">{chinese ? '已保存' : 'Saved'}</p> : null}
    {status === 'failed' ? <p role="alert" className="text-support text-destructive">{chinese ? '无法保存 System One 配置' : 'Could not save System One settings'}</p> : null}
  </form>
}
