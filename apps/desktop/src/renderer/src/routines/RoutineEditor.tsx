import { useAtomSet, useAtomValue } from '@effect/atom-react'
import { Button } from '@folio/ui/components/ui/button'
import { useRef, useState } from 'react'
import type { RoutineDefinition, RoutineRecord } from '../../../shared/routine'
import { HarnessStoreError } from '../../../shared/harness'
import { useLocale } from '../preferences'
import { TaskRpcClient } from '../rpc/task-rpc'
import { IntegrationRpcClient } from '../rpc/integration-rpc'
import { modelCatalogAtom, modelsAtom } from '../rpc/model-rpc'

const control = 'block w-full rounded-md border bg-background px-3 py-2 focus-visible:outline-primary'

/** Edits an explicit version snapshot; background query refreshes never replace a local draft. */
export function RoutineEditor({ vaultId, initial, onSaved, onCancel }: {
  vaultId: string; initial: { id: string; record?: RoutineRecord }; onSaved: () => void; onCancel: () => void
}): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const save = useAtomSet(TaskRpcClient.saveRoutine, { mode: 'promise' })
  const integrations = useAtomValue(IntegrationRpcClient.integrations)
  const catalog = useAtomValue(modelCatalogAtom)
  const settings = useAtomValue(modelsAtom)
  const [draft, setDraft] = useState<RoutineDefinition>(() => initial.record?.definition ?? {
    name: '', prompt: '', configuration: { agent: 'pi', skillIds: [], integrationIds: [] }, model: null, enabled: true
  })
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState<'conflict' | 'unconfirmed' | null>(null)
  const busy = useRef(false)
  const choices = catalog._tag === 'Success' && settings._tag === 'Success'
    ? catalog.value.models.filter(model => model.source === 'builtin' && settings.value.configuredProviders?.includes(model.providerId)) : []
  const modelKey = draft.model ? JSON.stringify([draft.model.providerId, draft.model.modelId]) : ''
  const knownModel = choices.some(model => JSON.stringify([model.providerId, model.modelId]) === modelKey)
  const knownIntegrations = integrations._tag === 'Success' ? integrations.value : []

  /** Keep the same identity and expected version after an uncertain response; main rejects stale overwrites. */
  async function submit(): Promise<void> {
    if (busy.current || !draft.name.trim() || !draft.prompt.trim() || (draft.configuration.agent === 'pi' && !draft.model)) return
    busy.current = true
    setPending(true)
    setFailed(null)
    try {
      await save({ payload: { vaultId, input: { id: initial.id,
        expectedRevision: initial.record?.revision ?? null,
        definition: { ...draft, name: draft.name.trim(), prompt: draft.prompt.trim() } } } })
      onSaved()
    } catch (error) { setFailed(error instanceof HarnessStoreError && error.reason === 'routine-conflict' ? 'conflict' : 'unconfirmed') }
    finally { busy.current = false; setPending(false) }
  }

  return <form className="space-y-3 rounded-lg border p-4" onSubmit={event => { event.preventDefault(); void submit() }}>
    <fieldset className="space-y-3" disabled={pending}>
      <label className="block space-y-1 text-ui"><span>{chinese ? 'Routine 名称' : 'Routine name'}</span>
        <input className={control} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} required />
      </label>
      <label className="block space-y-1 text-ui"><span>Prompt</span>
        <textarea className={`${control} min-h-24`} value={draft.prompt} required
          onChange={event => setDraft({ ...draft, prompt: event.target.value })} />
      </label>
      <label className="block space-y-1 text-ui"><span>Agent</span>
        <select className={control} value={draft.configuration.agent} onChange={event => {
          const agent = event.target.value === 'codex' ? 'codex' : 'pi'
          setDraft({ ...draft, configuration: { ...draft.configuration, agent }, model: agent === 'codex' ? null : draft.model })
        }}><option value="pi">pi</option><option value="codex">Codex</option></select>
      </label>
      {draft.configuration.agent === 'pi' ? <>
        <label className="block space-y-1 text-ui"><span>{chinese ? '模型' : 'Model'}</span>
          <select className={control} value={modelKey} onChange={event => {
            const selected = choices.find(model => JSON.stringify([model.providerId, model.modelId]) === event.target.value)
            setDraft({ ...draft, model: selected ? { providerId: selected.providerId, modelId: selected.modelId, thinkingLevel: 'off' } : null })
          }}>
            <option value="">{chinese ? '请选择模型' : 'Choose a model'}</option>
            {modelKey && !knownModel ? <option value={modelKey}>{draft.model!.providerId} / {draft.model!.modelId} ({chinese ? '当前不可用' : 'currently unavailable'})</option> : null}
            {choices.map(model => <option key={JSON.stringify([model.providerId, model.modelId])} value={JSON.stringify([model.providerId, model.modelId])}>{model.providerName} / {model.modelName}</option>)}
          </select>
        </label>
        {draft.model ? <label className="block space-y-1 text-ui"><span>{chinese ? '思考强度' : 'Thinking level'}</span>
          <select className={control} value={draft.model.thinkingLevel} onChange={event => {
            const level = levels.find(level => level === event.target.value)
            if (level && draft.model) setDraft({ ...draft, model: { ...draft.model, thinkingLevel: level } })
          }}>{levels.map(level => <option key={level} value={level}>{level}</option>)}</select>
        </label> : null}
      </> : <p className="text-support text-muted-foreground">{chinese ? '使用本机 Codex 的模型配置。' : 'Uses the local Codex model configuration.'}</p>}
      <fieldset className="space-y-2"><legend className="text-ui">{chinese ? '集成' : 'Integrations'}</legend>
        {[...knownIntegrations.map(item => ({ id: item.id, name: item.name })),
          ...draft.configuration.integrationIds.filter(id => !knownIntegrations.some(item => item.id === id)).map(id => ({ id, name: id }))]
          .map(item => <label key={item.id} className="flex items-center gap-2 text-support">
            <input type="checkbox" checked={draft.configuration.integrationIds.includes(item.id)} onChange={event => setDraft({ ...draft,
              configuration: { ...draft.configuration, integrationIds: event.target.checked
                ? [...draft.configuration.integrationIds, item.id].sort() : draft.configuration.integrationIds.filter(id => id !== item.id) } })} />{item.name}
          </label>)}
        {integrations._tag === 'Failure' ? <p role="alert">{chinese ? '集成列表加载失败，已选集成仍会保留。' : 'Could not load integrations. Saved selections are retained.'}</p> : null}
      </fieldset>
      <label className="flex items-center gap-2 text-ui"><input type="checkbox" checked={draft.enabled}
        onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />{chinese ? '启用 Routine' : 'Enable Routine'}</label>
    </fieldset>
    <div className="flex gap-2">
      <Button type="submit" disabled={pending || !draft.name.trim() || !draft.prompt.trim() || (draft.configuration.agent === 'pi' && !draft.model)}>{pending ? (chinese ? '保存中…' : 'Saving…') : (chinese ? '保存 Routine' : 'Save Routine')}</Button>
      <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>{chinese ? '关闭编辑' : 'Close editor'}</Button>
    </div>
    {failed ? <p role="alert" className="text-support text-destructive">{failed === 'conflict'
      ? (chinese ? '同步冲突解决前无法启用。草稿已保留；可取消勾选“启用 Routine”后保存。' : 'Resolve synchronization conflicts before enabling. Your draft is retained; uncheck Enable Routine to save it while paused.')
      : (chinese ? '保存未确认，草稿已保留。可重试；若版本已变化，刷新列表后重新打开该 Routine。' : 'Save was not confirmed. Your draft is retained. Retry, or refresh the list and reopen the Routine if its version changed.')}</p> : null}
  </form>
}
const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
