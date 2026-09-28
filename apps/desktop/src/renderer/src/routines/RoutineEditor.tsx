import { useAtomRefresh, useAtomSet, useAtomValue } from '@effect/atom-react'
import { Button } from '@folio/ui/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@folio/ui/components/ui/card'
import { Field, FieldGroup, FieldLabel } from '@folio/ui/components/ui/field'
import { Input } from '@folio/ui/components/ui/input'
import { Skeleton } from '@folio/ui/components/ui/skeleton'
import { useState } from 'react'
import type { IntegrationView } from '../../../shared/integration'
import type { RoutineRecord } from '../../../shared/routine'
import { useLocale } from '../preferences'
import { ConfigRpcClient } from '../rpc/config-rpc'
import { IntegrationRpcClient } from '../rpc/integration-rpc'
import { TaskRpcClient } from '../rpc/task-rpc'

type AgentConfiguration = Extract<RoutineRecord, { type: 'agent' }>['configuration']
type DraftBase = { name: string; intervalMinutes: number; timeZone: string; enabled: boolean }
type AgentDraft = DraftBase & { type: 'agent'; configuration: AgentConfiguration }
type IngestionDraft = DraftBase & { type: 'ingestion'; configuration: { integrationId: string; resourceId: string } }
type Draft = AgentDraft | IngestionDraft

const selectClass = 'h-8 w-full rounded-md border border-input bg-background px-2 text-ui'
const defaultSchedule = (timeZone: string): DraftBase => ({ name: '', intervalMinutes: 60, timeZone, enabled: true })
const newAgentDraft = (timeZone: string): AgentDraft => ({ ...defaultSchedule(timeZone), type: 'agent', configuration: { goal: '', agent: 'codex', model: null, skillIds: [], integrationIds: [], resourceIds: [] } })
const newIngestionDraft = (timeZone: string): IngestionDraft => ({ ...defaultSchedule(timeZone), type: 'ingestion', configuration: { integrationId: '', resourceId: '' } })

/** A new Routine must use the persisted default, never the renderer's live OS zone. */
export function RoutineEditor({ initial, onSaved, onCancel }: { initial: { id: string; record?: RoutineRecord }; onSaved: () => void; onCancel: () => void }): React.JSX.Element {
  const config = useAtomValue(ConfigRpcClient.watch)
  const refresh = useAtomRefresh(ConfigRpcClient.watch)
  if (!initial.record && config._tag === 'Failure') return <div role="alert"><p>Could not load the default time zone.</p><Button onClick={refresh}>Retry</Button></div>
  if (!initial.record && config._tag !== 'Success') return <Skeleton role="status" className="h-72 w-full" />
  return <RoutineEditorForm initial={initial} onSaved={onSaved} onCancel={onCancel} defaultTimeZone={config._tag === 'Success' ? config.value.timeZone : initial.record?.trigger.type === 'schedule' ? initial.record.trigger.timeZone : 'UTC'} />
}

/** Edits typed Routine intent; the executor type is immutable after creation. */
function RoutineEditorForm({ initial, onSaved, onCancel, defaultTimeZone }: { initial: { id: string; record?: RoutineRecord }; onSaved: () => void; onCancel: () => void; defaultTimeZone: string }): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const save = useAtomSet(TaskRpcClient.saveRoutine, { mode: 'promise' })
  const integrationResult = useAtomValue(IntegrationRpcClient.integrations)
  const integrations = integrationResult._tag === 'Success' ? integrationResult.value : null
  const [draft, setDraft] = useState<Draft>(() => {
    const record = initial.record
    if (!record) return newAgentDraft(defaultTimeZone)
    const schedule = { name: record.name, intervalMinutes: record.trigger.type === 'schedule' ? record.trigger.intervalMinutes : 60, timeZone: record.trigger.type === 'schedule' ? record.trigger.timeZone : defaultTimeZone, enabled: record.enabled }
    return record.type === 'agent'
      ? { ...schedule, type: 'agent', configuration: { ...record.configuration, skillIds: [...record.configuration.skillIds], integrationIds: [...record.configuration.integrationIds], resourceIds: [...record.configuration.resourceIds] } }
      : { ...schedule, type: 'ingestion', configuration: { ...record.configuration } }
  })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const systemIntake = initial.record?.trigger.type === 'event'
  const valid = draft.name.trim() && (systemIntake || draft.intervalMinutes >= 1) && (draft.type === 'ingestion'
    ? draft.configuration.integrationId && draft.configuration.resourceId
    : draft.configuration.goal.trim() && (draft.configuration.agent !== 'pi'
      || Boolean(draft.configuration.model?.providerId && draft.configuration.model.modelId)))

  async function submit(): Promise<void> {
    if (!valid || pending) return
    setPending(true)
    setError(null)
    try {
      const input = draft.type === 'agent' ? {
        id: initial.id, expectedRevision: initial.record?.revision ?? null, name: draft.name.trim(),
        trigger: systemIntake ? { type: 'event' as const, signal: 'raws-changed' as const } : { type: 'schedule' as const, intervalMinutes: draft.intervalMinutes, timeZone: draft.timeZone }, enabled: draft.enabled, type: draft.type,
        configuration: { ...draft.configuration, goal: draft.configuration.goal.trim(), model: draft.configuration.agent === 'pi' ? draft.configuration.model : null }
      } as const : {
        id: initial.id, expectedRevision: initial.record?.revision ?? null, name: draft.name.trim(),
        trigger: { type: 'schedule' as const, intervalMinutes: draft.intervalMinutes, timeZone: draft.timeZone }, enabled: draft.enabled, type: draft.type,
        configuration: draft.configuration
      } as const
      await save({ payload: { input } })
      onSaved()
    } catch {
      setError(chinese ? '保存未确认，请重试。' : 'Save was not confirmed. Please retry.')
    } finally {
      setPending(false)
    }
  }

  return <Card><form onSubmit={event => { event.preventDefault(); void submit() }}>
    <CardHeader className="border-b"><CardTitle>{initial.record ? (chinese ? '编辑 Routine' : 'Edit Routine') : (chinese ? '新建 Routine' : 'New Routine')}</CardTitle><CardDescription>{chinese ? 'Ingestion 直接从一个集成资源生成 raws；Agent Routine 执行对话任务。' : 'Ingestion writes raws from one Integration resource; Agent Routines run conversational tasks.'}</CardDescription></CardHeader>
    <CardContent className="pt-4"><fieldset disabled={pending}><FieldGroup className="gap-4">
      <Field><FieldLabel htmlFor="routine-name">{chinese ? '名称' : 'Name'}</FieldLabel><Input id="routine-name" disabled={systemIntake} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></Field>
      <div className="grid gap-4 sm:grid-cols-3">
        {!systemIntake && <><Field><FieldLabel htmlFor="routine-type">{chinese ? '类型' : 'Type'}</FieldLabel><select id="routine-type" className={selectClass} value={draft.type} disabled={Boolean(initial.record)} onChange={event => setDraft(event.target.value === 'ingestion' ? newIngestionDraft(draft.timeZone) : newAgentDraft(draft.timeZone))}><option value="agent">Agent</option><option value="ingestion">Ingestion</option></select></Field>
        <Field><FieldLabel htmlFor="routine-interval">{chinese ? '检查周期（分钟）' : 'Check interval (minutes)'}</FieldLabel><Input id="routine-interval" type="number" min={1} value={draft.intervalMinutes} onChange={event => setDraft({ ...draft, intervalMinutes: Number(event.target.value) })} /></Field>
        <Field><FieldLabel htmlFor="routine-timezone">{chinese ? '时区' : 'Time zone'}</FieldLabel><Input id="routine-timezone" value={draft.timeZone} onChange={event => setDraft({ ...draft, timeZone: event.target.value })} /></Field></>}
      </div>
      {draft.type === 'agent' ? <AgentFields draft={draft} setDraft={setDraft} chinese={chinese} integrations={systemIntake ? null : integrations} />
        : <IngestionFields draft={draft} setDraft={setDraft} chinese={chinese} integrations={integrations} />}
      <label className="flex items-center gap-2 text-ui"><input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />{chinese ? '启用 Routine' : 'Enable Routine'}</label>
    </FieldGroup></fieldset></CardContent>
    <CardFooter className="flex gap-2"><Button type="submit" disabled={pending || !valid}>{pending ? (chinese ? '保存中…' : 'Saving…') : (chinese ? '保存' : 'Save')}</Button><Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>{chinese ? '取消' : 'Cancel'}</Button></CardFooter>
    {error ? <p role="alert" className="px-4 pb-4 text-support text-destructive">{error}</p> : null}
  </form></Card>
}

function AgentFields({ draft, setDraft, chinese, integrations }: { draft: AgentDraft; setDraft: React.Dispatch<React.SetStateAction<Draft>>; chinese: boolean; integrations: readonly IntegrationView[] | null }): React.JSX.Element {
  const configuration = draft.configuration
  return <>
    <Field><FieldLabel htmlFor="routine-goal">{chinese ? '任务目标' : 'Goal'}</FieldLabel><textarea id="routine-goal" className="min-h-28 w-full rounded-md border border-input bg-background p-2 text-ui" value={configuration.goal} onChange={event => setDraft({ ...draft, configuration: { ...configuration, goal: event.target.value } })} /></Field>
    <Field><FieldLabel htmlFor="routine-agent">Agent</FieldLabel><select id="routine-agent" className={selectClass} value={configuration.agent} onChange={event => setDraft({ ...draft, configuration: { ...configuration, agent: event.target.value === 'codex' ? 'codex' : 'pi', model: event.target.value === 'codex' ? null : configuration.model } })}><option value="pi">pi</option><option value="codex">Codex</option></select></Field>
    {configuration.agent === 'pi' ? <div className="grid gap-4 sm:grid-cols-3"><Field><FieldLabel htmlFor="routine-provider">Provider ID</FieldLabel><Input id="routine-provider" value={configuration.model?.providerId ?? ''} onChange={event => setDraft({ ...draft, configuration: { ...configuration, model: { providerId: event.target.value, modelId: configuration.model?.modelId ?? '', thinkingLevel: configuration.model?.thinkingLevel ?? 'off' } } })} /></Field><Field><FieldLabel htmlFor="routine-model">Model ID</FieldLabel><Input id="routine-model" value={configuration.model?.modelId ?? ''} onChange={event => setDraft({ ...draft, configuration: { ...configuration, model: { providerId: configuration.model?.providerId ?? '', modelId: event.target.value, thinkingLevel: configuration.model?.thinkingLevel ?? 'off' } } })} /></Field><Field><FieldLabel htmlFor="routine-thinking">{chinese ? '思考强度' : 'Thinking level'}</FieldLabel><select id="routine-thinking" className={selectClass} value={configuration.model?.thinkingLevel ?? 'off'} onChange={event => setDraft({ ...draft, configuration: { ...configuration, model: { providerId: configuration.model?.providerId ?? '', modelId: configuration.model?.modelId ?? '', thinkingLevel: event.target.value as NonNullable<AgentConfiguration['model']>['thinkingLevel'] } } })}><option value="off">off</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select></Field></div> : null}
    {integrations ? <fieldset className="space-y-2"><legend className="text-ui">{chinese ? 'Agent 可用资源' : 'Resources available to Agent'}</legend>{integrations.flatMap(integration => integration.resources.map(resource => {
      const key = `${integration.id}/${resource.id}`
      const registered = Boolean(integration.record?.resources.some(candidate => candidate.id === resource.id))
      const ready = integration.record?.state !== undefined && integration.states[integration.record.state]?.kind === 'ready'
      const available = registered && !integration.busy && ready
      const checked = configuration.resourceIds.includes(key)
      const label = typeof resource.name === 'string' ? resource.name : resource.name[chinese ? 'zh-CN' : 'en']
      return <label key={key} className="flex items-center gap-2 text-support"><input type="checkbox" disabled={!available && !checked} checked={checked} onChange={event => {
        const resourceIds = event.target.checked ? [...configuration.resourceIds, key].sort() : configuration.resourceIds.filter(id => id !== key)
        const integrationIds = resourceIds.some(id => id.startsWith(`${integration.id}/`)) ? [...new Set([...configuration.integrationIds, integration.id])].sort() : configuration.integrationIds.filter(id => id !== integration.id)
        setDraft({ ...draft, configuration: { ...configuration, resourceIds, integrationIds } })
      }} />{integration.name} / {label}{!available ? <span className="text-muted-foreground">{chinese ? '（请先连接）' : ' (Connect first)'}</span> : null}</label>
    }))}</fieldset> : null}
  </>
}

function IngestionFields({ draft, setDraft, chinese, integrations }: { draft: IngestionDraft; setDraft: React.Dispatch<React.SetStateAction<Draft>>; chinese: boolean; integrations: readonly IntegrationView[] | null }): React.JSX.Element {
  const selected = `${draft.configuration.integrationId}/${draft.configuration.resourceId}`
  return <fieldset className="space-y-2"><legend className="text-ui">{chinese ? '数据源（单选）' : 'Source (choose one)'}</legend>
    {integrations ? integrations.flatMap(integration => integration.resources.map(resource => {
      const key = `${integration.id}/${resource.id}`
      const registered = Boolean(integration.record?.resources.some(candidate => candidate.id === resource.id))
      const ready = integration.record?.state !== undefined && integration.states[integration.record.state]?.kind === 'ready'
      const available = registered && !integration.busy && ready
      const label = typeof resource.name === 'string' ? resource.name : resource.name[chinese ? 'zh-CN' : 'en']
      return <label key={key} className="flex items-center gap-2 text-support"><input type="radio" name="ingestion-resource" disabled={!available && selected !== key} checked={selected === key} onChange={() => setDraft({ ...draft, configuration: { integrationId: integration.id, resourceId: resource.id } })} />{integration.name} / {label}{!available ? <span className="text-muted-foreground">{chinese ? '（请先连接）' : ' (Connect first)'}</span> : null}</label>
    })) : <p className="text-support text-muted-foreground">{chinese ? '正在加载集成资源…' : 'Loading Integration resources…'}</p>}
  </fieldset>
}
