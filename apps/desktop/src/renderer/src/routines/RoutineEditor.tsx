import { useAtomSet } from '@effect/atom-react'
import { Button } from '@folio/ui/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@folio/ui/components/ui/card'
import { Field, FieldGroup, FieldLabel } from '@folio/ui/components/ui/field'
import { Input } from '@folio/ui/components/ui/input'
import { useState } from 'react'
import type { RoutineRecord } from '../../../shared/routine'
import { useLocale } from '../preferences'
import { TaskRpcClient } from '../rpc/task-rpc'
import { IntegrationRpcClient } from '../rpc/integration-rpc'
import { useAtomValue } from '@effect/atom-react'

type Draft = { name: string; prompt: string; agent: 'pi' | 'codex'; model: RoutineRecord['model']; skillIds: string[]; integrationIds: string[]; resourceIds: string[]; intervalMinutes: number; timeZone: string; enabled: boolean }
const selectClass = 'h-8 w-full rounded-md border border-input bg-background px-2 text-ui'

/** Flat editor for the current Routine contract; historical executions are never edited here. */
export function RoutineEditor({ vaultId, initial, onSaved, onCancel }: { vaultId: string; initial: { id: string; record?: RoutineRecord }; onSaved: () => void; onCancel: () => void }): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const save = useAtomSet(TaskRpcClient.saveRoutine, { mode: 'promise' })
  const integrations = useAtomValue(IntegrationRpcClient.integrations)
  const [draft, setDraft] = useState<Draft>(() => {
    const r = initial.record
    return r ? { name: r.name, prompt: r.prompt, agent: r.agent, model: r.model, skillIds: [...r.skillIds], integrationIds: [...r.integrationIds], resourceIds: [...(r.resourceIds ?? [])], intervalMinutes: r.intervalMinutes, timeZone: r.timeZone, enabled: r.enabled } : { name: '', prompt: '', agent: 'codex', model: null, skillIds: [], integrationIds: [], resourceIds: [], intervalMinutes: 60, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', enabled: true }
  })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function submit(): Promise<void> {
    if (!draft.name.trim() || !draft.prompt.trim() || draft.intervalMinutes < 1 || (draft.agent === 'pi' && (!draft.model?.providerId || !draft.model.modelId)) || pending) return
    setPending(true); setError(null)
    try {
      // A resource is addressable as "integration/resource". Derive the integration
      // list from the selected resources so a legacy routine cannot retain an
      // unrelated integration and fail during resource preparation.
      const integrationIds = draft.resourceIds.length
        ? [...new Set(draft.resourceIds.map(resource => resource.slice(0, resource.indexOf('/'))).filter(Boolean))].sort()
        : draft.integrationIds
      await save({ payload: { vaultId, input: { id: initial.id, expectedRevision: initial.record?.revision ?? null, ...draft, integrationIds, name: draft.name.trim(), prompt: draft.prompt.trim(), model: draft.agent === 'pi' ? draft.model : null } } })
      onSaved()
    } catch { setError(chinese ? '保存未确认，请重试。' : 'Save was not confirmed. Please retry.') }
    finally { setPending(false) }
  }
  return <Card><form onSubmit={event => { event.preventDefault(); void submit() }}>
    <CardHeader className="border-b"><CardTitle>{initial.record ? (chinese ? '编辑 Routine' : 'Edit Routine') : (chinese ? '新建 Routine' : 'New Routine')}</CardTitle><CardDescription>{chinese ? 'Routine 只处理当前业务日；次日首次执行负责前一天收尾。' : 'A Routine processes the current business day; the next day closes the previous day.'}</CardDescription></CardHeader>
    <CardContent className="pt-4"><fieldset disabled={pending}><FieldGroup className="gap-4">
      <Field><FieldLabel htmlFor="routine-name">{chinese ? '名称' : 'Name'}</FieldLabel><Input id="routine-name" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></Field>
      <Field><FieldLabel htmlFor="routine-prompt">Prompt</FieldLabel><textarea id="routine-prompt" className="min-h-28 w-full rounded-md border border-input bg-background p-2 text-ui" value={draft.prompt} onChange={e => setDraft({ ...draft, prompt: e.target.value })} /></Field>
      <div className="grid gap-4 sm:grid-cols-3"><Field><FieldLabel htmlFor="routine-agent">Agent</FieldLabel><select id="routine-agent" className={selectClass} value={draft.agent} onChange={e => setDraft({ ...draft, agent: e.target.value === 'codex' ? 'codex' : 'pi', model: e.target.value === 'codex' ? null : draft.model })}><option value="pi">pi</option><option value="codex">Codex</option></select></Field><Field><FieldLabel htmlFor="routine-interval">{chinese ? '频率（分钟）' : 'Interval (minutes)'}</FieldLabel><Input id="routine-interval" type="number" min={1} value={draft.intervalMinutes} onChange={e => setDraft({ ...draft, intervalMinutes: Number(e.target.value) })} /></Field><Field><FieldLabel htmlFor="routine-timezone">{chinese ? '时区' : 'Time zone'}</FieldLabel><Input id="routine-timezone" value={draft.timeZone} onChange={e => setDraft({ ...draft, timeZone: e.target.value })} /></Field></div>
      {draft.agent === 'pi' ? <div className="grid gap-4 sm:grid-cols-3"><Field><FieldLabel htmlFor="routine-provider">{chinese ? 'Provider ID' : 'Provider ID'}</FieldLabel><Input id="routine-provider" value={draft.model?.providerId ?? ''} onChange={e => setDraft({ ...draft, model: { providerId: e.target.value, modelId: draft.model?.modelId ?? '', thinkingLevel: draft.model?.thinkingLevel ?? 'off' } })} /></Field><Field><FieldLabel htmlFor="routine-model">{chinese ? 'Model ID' : 'Model ID'}</FieldLabel><Input id="routine-model" value={draft.model?.modelId ?? ''} onChange={e => setDraft({ ...draft, model: { providerId: draft.model?.providerId ?? '', modelId: e.target.value, thinkingLevel: draft.model?.thinkingLevel ?? 'off' } })} /></Field><Field><FieldLabel htmlFor="routine-thinking">{chinese ? '思考强度' : 'Thinking level'}</FieldLabel><select id="routine-thinking" className={selectClass} value={draft.model?.thinkingLevel ?? 'off'} onChange={e => setDraft({ ...draft, model: { providerId: draft.model?.providerId ?? '', modelId: draft.model?.modelId ?? '', thinkingLevel: e.target.value as NonNullable<Draft['model']>['thinkingLevel'] } })}><option value="off">off</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select></Field></div> : null}
      {integrations._tag === 'Success' ? <fieldset className="space-y-2"><legend className="text-ui">{chinese ? '资源' : 'Resources'}</legend>{integrations.value.flatMap(integration => integration.resources.map(resource => {
        const key = `${integration.id}/${resource.id}`
        const registered = Boolean(integration.record?.resources.some(candidate => candidate.id === resource.id))
        const ready = integration.record?.state !== undefined && integration.states[integration.record.state]?.kind === 'ready'
        const available = registered && !integration.busy && ready
        const checked = draft.resourceIds.includes(key)
        const label = typeof resource.name === 'string' ? resource.name : resource.name[chinese ? 'zh-CN' : 'en']
        const unavailableLabel = !registered ? (chinese ? '（未注册）' : ' (Not installed)') : !available ? (chinese ? '（请先连接）' : ' (Connect first)') : ''
        return <label key={key} className="flex items-center gap-2 text-support"><input type="checkbox" disabled={!available && !checked} checked={checked} onChange={event => setDraft(current => { const resourceIds = event.target.checked ? [...current.resourceIds, key].sort() : current.resourceIds.filter(id => id !== key); const integrationIds = resourceIds.some(id => id.startsWith(`${integration.id}/`)) ? [...new Set([...current.integrationIds, integration.id])].sort() : current.integrationIds.filter(id => id !== integration.id); return { ...current, resourceIds, integrationIds } })} />{integration.name} / {label}{unavailableLabel ? <span className="text-muted-foreground">{unavailableLabel}</span> : null}</label>
      }))}</fieldset> : null}
      <label className="flex items-center gap-2 text-ui"><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />{chinese ? '启用 Routine' : 'Enable Routine'}</label>
    </FieldGroup></fieldset></CardContent>
    <CardFooter className="flex gap-2"><Button type="submit" disabled={pending || !draft.name.trim() || !draft.prompt.trim() || draft.intervalMinutes < 1 || (draft.agent === 'pi' && (!draft.model?.providerId || !draft.model.modelId))}>{pending ? (chinese ? '保存中…' : 'Saving…') : (chinese ? '保存' : 'Save')}</Button><Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>{chinese ? '取消' : 'Cancel'}</Button></CardFooter>
    {error ? <p role="alert" className="px-4 pb-4 text-support text-destructive">{error}</p> : null}
  </form></Card>
}
