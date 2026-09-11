import { useAtomRefresh, useAtomSet, useAtomValue } from '@effect/atom-react'
import { Badge } from '@folio/ui/components/ui/badge'
import { Button } from '@folio/ui/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@folio/ui/components/ui/card'
import { useState } from 'react'
import type { RoutineRecord, RoutineExecution } from '../../../shared/routine'
import { useLocale } from '../preferences'
import { TaskRpcClient } from '../rpc/task-rpc'
import { RoutineEditor } from './RoutineEditor'

function executionLabel(execution: RoutineExecution, chinese: boolean): string {
  if (execution.isEnd) return chinese ? '日终收尾' : 'Day close'
  if (execution.status === 'pending') return chinese ? '待处理' : 'Pending'
  if (execution.status === 'succeeded') return chinese ? '已完成' : 'Succeeded'
  return execution.status
}

function deriveGapDates(rows: readonly RoutineExecution[]): string[] {
  const completed = new Set(rows.filter(row => row.isEnd && row.status === 'succeeded').map(row => row.routineDate))
  const dates = rows.map(row => row.routineDate).sort()
  if (!dates.length) return []
  const cursor = new Date(`${dates[dates.length - 1]}T12:00:00Z`)
  const today = new Date(); today.setUTCHours(12, 0, 0, 0)
  const gaps: string[] = []
  for (let date = new Date(`${dates[0]}T12:00:00Z`); date < today; date.setUTCDate(date.getUTCDate() + 1)) {
    const key = date.toISOString().slice(0, 10)
    if (date <= cursor && !completed.has(key)) gaps.push(key)
  }
  return gaps
}

/** Routine workspace: flat configuration, one coalescing execution, and a derived calendar. */
export function RoutinePanel({ vaultId }: { vaultId: string }): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const query = TaskRpcClient.query('routines.list', { vaultId })
  const result = useAtomValue(query)
  const refresh = useAtomRefresh(query)
  const [editing, setEditing] = useState<{ id: string; record?: RoutineRecord } | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const records = result._tag === 'Success' ? result.value : []
  const selected = records.find(r => r.id === selectedId) ?? records[0]
  return <section className="flex flex-col gap-5" aria-labelledby="routines-title">
    <div className="flex items-center justify-between gap-3"><div><h2 id="routines-title" className="text-lg font-semibold">Routines</h2><p className="mt-1 text-support text-muted-foreground">{chinese ? '按频率处理当天消息或邮件' : 'Process today’s messages or mail at a fixed interval'}</p></div><div className="flex gap-2"><Button variant="ghost" size="sm" onClick={refresh}>{chinese ? '刷新' : 'Refresh'}</Button><Button size="sm" onClick={() => setEditing({ id: crypto.randomUUID() })}>{chinese ? '新建' : 'New'}</Button></div></div>
    {editing ? <RoutineEditor vaultId={vaultId} initial={editing} onSaved={() => { setEditing(null); refresh() }} onCancel={() => setEditing(null)} /> : result._tag !== 'Success' ? <p role="status" className="text-support text-muted-foreground">{result._tag === 'Failure' ? (chinese ? '无法加载 Routine。' : 'Could not load Routines.') : (chinese ? '加载中…' : 'Loading…')}</p> : records.length === 0 ? <Card><CardContent className="p-8 text-center"><p className="text-ui">{chinese ? '还没有 Routine' : 'No Routines yet'}</p><Button className="mt-4" size="sm" onClick={() => setEditing({ id: crypto.randomUUID() })}>{chinese ? '新建 Routine' : 'Create Routine'}</Button></CardContent></Card> : <div className="grid overflow-hidden rounded-lg border bg-card md:grid-cols-[14rem_minmax(0,1fr)]"><aside className="border-b bg-muted/20 md:border-r md:border-b-0"><div className="flex h-9 items-center justify-between border-b px-3"><span className="text-support font-medium">{chinese ? '全部 Routine' : 'All Routines'}</span><span className="text-support tabular-nums">{records.length}</span></div><ul className="p-1">{records.map(record => <li key={record.id}><button type="button" className="flex w-full flex-col items-start gap-1 rounded-md px-2.5 py-2 text-left hover:bg-sidebar-accent" data-selected={selected?.id === record.id} onClick={() => setSelectedId(record.id)}><span className="flex w-full items-center gap-2"><span className="min-w-0 flex-1 truncate text-ui font-medium">{record.name}</span><span className={`size-1.5 rounded-full ${record.enabled ? 'bg-success' : 'bg-muted-foreground/40'}`} /></span><span className="line-clamp-2 text-support text-muted-foreground">{record.prompt}</span></button></li>)}</ul></aside><div className="min-w-0 p-3 md:p-4">{selected ? <RoutineEntry vaultId={vaultId} record={selected} onEdit={() => setEditing({ id: selected.id, record: selected })} refreshRoutines={refresh} /> : null}</div></div>}
  </section>
}

function RoutineEntry({ vaultId, record, onEdit, refreshRoutines }: { vaultId: string; record: RoutineRecord; onEdit: () => void; refreshRoutines: () => void }): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const executionsQuery = TaskRpcClient.query('routines.executions', { vaultId, routineId: record.id })
  const executions = useAtomValue(executionsQuery)
  const refreshExecutions = useAtomRefresh(executionsQuery)
  const run = useAtomSet(TaskRpcClient.runRoutine, { mode: 'promise' })
  const prepare = useAtomSet(TaskRpcClient.prepareRoutine, { mode: 'promise' })
  const save = useAtomSet(TaskRpcClient.saveRoutine, { mode: 'promise' })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  async function invoke(kind: 'run' | 'prepare'): Promise<void> { if (busy) return; setBusy(true); setMessage(''); try { await (kind === 'run' ? run : prepare)({ payload: { vaultId, input: { routineId: record.id } } }); setMessage(chinese ? '已登记；后续触发会合并到同一执行记录。' : 'Recorded. Later triggers will coalesce into the same execution.'); refreshExecutions(); refreshRoutines() } catch { setMessage(chinese ? '执行未确认，请重试。' : 'Execution was not confirmed. Retry.') } finally { setBusy(false) } }
  async function toggle(): Promise<void> { if (busy) return; setBusy(true); try { await save({ payload: { vaultId, input: { id: record.id, expectedRevision: record.revision, name: record.name, prompt: record.prompt, agent: record.agent, model: record.model, skillIds: record.skillIds, integrationIds: record.integrationIds, intervalMinutes: record.intervalMinutes, timeZone: record.timeZone, enabled: !record.enabled } } }); refreshRoutines() } finally { setBusy(false) } }
  const rows = executions._tag === 'Success' ? executions.value : []
  const pending = rows.find(e => e.status === 'pending')
  const gaps = deriveGapDates(rows)
  return <Card><CardHeader className="gap-3 pb-3"><div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle className="text-base">{record.name}</CardTitle><CardDescription>{record.agent} · {record.intervalMinutes} min · {record.timeZone}</CardDescription></div><div className="flex gap-2"><Badge variant={record.enabled ? 'success' : 'outline'}>{record.enabled ? (chinese ? '已启用' : 'Enabled') : (chinese ? '已暂停' : 'Paused')}</Badge><Button variant="ghost" size="sm" disabled={busy} onClick={onEdit}>{chinese ? '编辑' : 'Edit'}</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => void toggle()}>{record.enabled ? (chinese ? '暂停' : 'Pause') : (chinese ? '启用' : 'Enable')}</Button></div></div></CardHeader><CardContent className="space-y-4"><p className="whitespace-pre-wrap text-support">{record.prompt}</p><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={() => void invoke('prepare')}>{chinese ? '准备任务' : 'Prepare task'}</Button><Button size="sm" disabled={busy || !record.enabled} onClick={() => void invoke('run')}>{chinese ? '运行一次' : 'Run once'}</Button></div>{pending ? <p className="rounded-md bg-muted/40 p-2 text-support">{chinese ? `当前待处理：${pending.routineDate}，已触发 ${pending.triggerCount} 次` : `Pending: ${pending.routineDate}, ${pending.triggerCount} trigger(s)`}</p> : null}<section aria-label={chinese ? '执行日历' : 'Execution calendar'}><h4 className="mb-2 text-ui font-medium">{chinese ? '执行日历' : 'Execution calendar'}</h4>{executions._tag === 'Success' ? <><ul className="space-y-1 text-support">{rows.slice(0, 14).map(e => <li key={e.id} className="flex items-center justify-between rounded border px-2 py-1"><span>{e.routineDate}{e.isEnd ? ' · ' + (chinese ? '日终' : 'end') : ''}</span><span>{executionLabel(e, chinese)}{e.taskId ? ' · task' : ''}</span></li>)}{rows.length === 0 ? <li className="text-muted-foreground">{chinese ? '暂无执行记录' : 'No executions yet'}</li> : null}</ul>{gaps.length ? <p className="mt-2 text-support text-warning">{chinese ? `检测到 ${gaps.length} 个待人工处理日期：${gaps.slice(0, 5).join('、')}` : `${gaps.length} gap day(s) require manual handling: ${gaps.slice(0, 5).join(', ')}`}</p> : null}</> : <p className="text-muted-foreground">{chinese ? '加载执行记录…' : 'Loading executions…'}</p>}</section>{message ? <p role="status" className="text-support text-muted-foreground">{message}</p> : null}</CardContent></Card>
}
