import { RoutineSchedules } from './RoutineSchedules'
import { useAtomRefresh, useAtomSet, useAtomValue } from '@effect/atom-react'
import { Button } from '@folio/ui/components/ui/button'
import { useRef, useState } from 'react'
import { HarnessStoreError } from '../../../shared/harness'
import type { RoutineRecord, TriggerRoutine } from '../../../shared/routine'
import { useLocale } from '../preferences'
import { TaskRpcClient } from '../rpc/task-rpc'
import { RoutineEditor } from './RoutineEditor'

/** Exposes saved definitions without starting execution on render, refresh or editing. */
export function RoutinePanel({ vaultId }: { vaultId: string }): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const query = TaskRpcClient.query('routines.list', { vaultId })
  const result = useAtomValue(query)
  const refresh = useAtomRefresh(query)
  const [showSchedules, setShowSchedules] = useState(false)
  const [editing, setEditing] = useState<{ id: string; record?: RoutineRecord } | null>(null)
  return <section className="mt-8 space-y-4" aria-labelledby="routines-title">
    <div className="flex items-center justify-between gap-3">
      <h2 id="routines-title" className="text-sm font-semibold">Routines</h2>
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={refresh}>{chinese ? '刷新 Routine 列表' : 'Refresh Routines'}</Button>
        <Button variant="outline" size="sm" disabled={editing !== null} onClick={() => setEditing({ id: crypto.randomUUID() })}>{chinese ? '新建 Routine' : 'New Routine'}</Button>
      </div>
    </div>
    <p className="text-support text-muted-foreground">{chinese ? '保存可复用的指令与 Agent 配置，可手动运行或设置每日计划。' : 'Save reusable instructions and Agent settings. Run on demand or configure a daily schedule.'}</p>
    <Button variant="ghost" size="sm" onClick={() => setShowSchedules(value => !value)}>{chinese ? '每日计划设置' : 'Daily schedule settings'}</Button>
    {showSchedules && result._tag === 'Success' ? <RoutineSchedules vaultId={vaultId} routines={result.value} /> : null}
    {editing ? <RoutineEditor key={`${editing.id}:${editing.record?.revision ?? 0}`} vaultId={vaultId} initial={editing}
      onSaved={() => { setEditing(null); refresh() }} onCancel={() => setEditing(null)} /> : null}
    {result._tag === 'Success' ? result.value.length ? <ul className="divide-y rounded-lg border">
      {result.value.map(record => <RoutineEntry key={record.id} vaultId={vaultId} record={record} refresh={refresh}
        onEdit={() => setEditing({ id: record.id, record })} editing={editing !== null} />)}
    </ul> : <p className="text-support text-muted-foreground">{chinese ? '还没有 Routine。' : 'No Routines yet.'}</p>
      : <p role="status" className="text-support text-muted-foreground">{result._tag === 'Failure'
        ? (chinese ? '无法加载 Routine，请刷新重试。' : 'Could not load Routines. Refresh to retry.')
        : (chinese ? '正在加载 Routine…' : 'Loading Routines…')}</p>}
  </section>
}

/** Retains uncertain trigger identity separately from the mutable Routine definition. */
function RoutineEntry({ vaultId, record, refresh, onEdit, editing }: {
  vaultId: string; record: RoutineRecord; refresh: () => void; onEdit: () => void; editing: boolean
}): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const save = useAtomSet(TaskRpcClient.saveRoutine, { mode: 'promise' })
  const start = useAtomSet(TaskRpcClient.startRoutineTask, { mode: 'promise' })
  const create = useAtomSet(TaskRpcClient.createRoutineTask, { mode: 'promise' })
  const query = TaskRpcClient.query('routines.triggers', { vaultId, routineId: record.id })
  const history = useAtomValue(query)
  const refreshHistory = useAtomRefresh(query)
  const wakeupQuery = TaskRpcClient.query('routines.wakeups', { vaultId, routineId: record.id })
  const wakeups = useAtomValue(wakeupQuery)
  const refreshWakeups = useAtomRefresh(wakeupQuery)
  const waiting = wakeups._tag === 'Success' ? wakeups.value.filter(wakeup => wakeup.triggerId === null) : []
  const refreshTasks = useAtomRefresh(TaskRpcClient.query('tasks.list', { vaultId }))
  const [pending, setPending] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState<{ input: TriggerRoutine; execute: boolean } | null>(null)
  const retrying = retry !== null
  const busy = useRef(false)

  /** Toggle applies only to future occurrences; main protects against a stale version. */
  async function toggle(): Promise<void> {
    if (busy.current) return
    busy.current = true; setPending(true); setMessage(''); setFailed(false)
    try {
      await save({ payload: { vaultId, input: { id: record.id, expectedRevision: record.revision,
        definition: { ...record.definition, enabled: !record.definition.enabled } } } })
    } catch (error) {
      setFailed(true)
      setMessage(error instanceof HarnessStoreError && error.reason === 'routine-conflict'
        ? (chinese ? '此 Routine 仍有未解决的同步冲突。请先在原任务中处理冲突，再启用。' : 'This Routine has unresolved synchronization conflicts. Resolve them in the original Task before enabling it.')
        : (chinese ? '状态更新未确认，请刷新查看最新状态。' : 'State update was not confirmed. Refresh to check the latest state.'))
    }
    finally { busy.current = false; setPending(false); refresh() }
  }

  /** Explicit preparation or execution; a retry preserves both occurrence identity and action intent. */
  async function prepare(input?: TriggerRoutine, fresh = false, execute = false): Promise<void> {
    if (busy.current) return
    const selected = input ?? (!fresh ? retry?.input : null) ?? { id: crypto.randomUUID(), routineId: record.id, expectedRevision: record.revision }
    const shouldExecute = !input && !fresh && retry ? retry.execute : execute
    busy.current = true; setPending(true); setMessage(''); setFailed(false)
    try {
      if (shouldExecute) {
        const result = await start({ payload: { vaultId, input: selected } })
        setMessage(['preparing', 'running'].includes(result.run.state)
          ? (chinese ? '本轮执行已登记，请在下方任务中查看进展。' : 'This run is registered. Follow its progress in Tasks below.')
          : (chinese ? '本轮已有执行记录，未重复发送指令。请在任务中查看结果或接续执行。' : 'This run already has a result. No prompt was resent. View or continue it from Tasks.'))
      } else {
        await create({ payload: { vaultId, input: selected } })
        setMessage(chinese ? '任务工作区已就绪，可在下方任务列表打开会话。尚未发送指令。' : 'Task workspace is ready. Open its session in Tasks below. No prompt has been sent.')
      }
      setRetry(null)
    } catch (error) {
      setRetry({ input: selected, execute: shouldExecute }); setFailed(true); setShowHistory(true)
      setMessage(error instanceof HarnessStoreError && error.reason === 'routine-busy'
        ? (chinese ? '同一 Routine 的另一个任务仍在执行或等待同步，请处理完成后重试。' : 'Another Task from this Routine is running or awaiting synchronization. Resolve it before retrying.')
        : shouldExecute
          ? (chinese ? '执行未确认。可重试或查看任务记录；已登记的 Prompt 不会重复发送。' : 'Execution was not confirmed. Retry or inspect the Task. A registered Prompt will not be resent.')
          : (chinese ? '任务创建未确认。重试会使用原触发记录；也可从历史记录恢复。' : 'Task creation was not confirmed. Retry uses the original occurrence; saved occurrences are also available in history.'))
    } finally { busy.current = false; setPending(false); refreshHistory(); refreshWakeups(); refreshTasks(); refresh() }
  }

  return <li className="space-y-3 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h3 className="text-ui font-medium">{record.definition.name}</h3>
        <p className="text-support text-muted-foreground">{record.definition.configuration.agent} · {record.definition.enabled ? (chinese ? '已启用' : 'Enabled') : (chinese ? '已暂停' : 'Paused')}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" size="sm" disabled={pending || editing} onClick={onEdit}>{chinese ? '编辑' : 'Edit'}</Button>
        <Button variant="ghost" size="sm" disabled={pending || editing} onClick={() => void toggle()}>{record.definition.enabled ? (chinese ? '暂停' : 'Pause') : (chinese ? '启用' : 'Enable')}</Button>
        <Button variant="outline" size="sm" disabled={pending || editing || (!record.definition.enabled && !retrying)} onClick={() => void prepare()}>
          {retrying ? (retry?.execute ? (chinese ? '重试执行' : 'Retry execution') : (chinese ? '重试创建任务' : 'Retry task creation')) : (chinese ? '创建任务' : 'Create task')}</Button>
        <Button size="sm" disabled={pending || editing || retrying || !record.definition.enabled} onClick={() => void prepare(undefined, true, true)}>{chinese ? '运行一次' : 'Run once'}</Button>
        {retrying && retry?.input.expectedRevision !== record.revision && record.definition.enabled ? <Button variant="ghost" size="sm" disabled={pending}
          onClick={() => void prepare(undefined, true)}>{chinese ? '用新版另建任务' : 'Create another with latest version'}</Button> : null}
      </div>
    </div>
    <p className="line-clamp-3 whitespace-pre-wrap break-words text-support">{record.definition.prompt}</p>
    <Button variant="ghost" size="sm" onClick={() => { setShowHistory(value => !value); refreshHistory(); refreshWakeups() }}>{chinese ? '触发历史' : 'Occurrence history'}</Button>
    {showHistory ? <section className="space-y-2 border-t pt-2" aria-label={chinese ? '待触发记录' : 'Pending occurrences'}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-ui font-medium">{chinese ? '待派发' : 'Awaiting dispatch'}</h4>
        <Button variant="ghost" size="sm" onClick={() => { refreshHistory(); refreshWakeups() }}>{chinese ? '刷新触发记录' : 'Refresh occurrences'}</Button>
      </div>
      {wakeups._tag === 'Success' ? waiting.length ? <>
        <p className="text-support text-muted-foreground">{chinese ? `${waiting.length} 次触发等待合并为一个任务。` : `${waiting.length} occurrences waiting to be combined into one task.`}
          {!record.definition.enabled ? (chinese ? ' Routine 已暂停，记录会保留。' : ' The Routine is paused; these records are retained.') : ''}</p>
        <ul className="space-y-1 text-support">{waiting.map(wakeup => <li key={wakeup.id}><time dateTime={new Date(wakeup.triggeredAt).toISOString()}>{new Date(wakeup.triggeredAt).toLocaleString(chinese ? 'zh-CN' : 'en')}</time></li>)}</ul>
      </> : <p className="text-support text-muted-foreground">{chinese ? '没有待派发的触发。' : 'No pending occurrences.'}</p>
        : <p role="status" className="text-support text-muted-foreground">{wakeups._tag === 'Failure'
          ? (chinese ? '无法加载待触发记录，请刷新重试。' : 'Could not load pending occurrences. Refresh to retry.')
          : (chinese ? '正在加载待触发记录…' : 'Loading pending occurrences…')}</p>}
    </section> : null}
    {showHistory ? history._tag === 'Success' ? <ul className="space-y-2 border-t pt-2">
      {history.value.length === 0 ? <li className="text-support text-muted-foreground">{chinese ? '还没有已接受的触发。' : 'No accepted occurrences yet.'}</li> : null}
      {history.value.map(trigger => <li key={trigger.id} className="space-y-1 rounded-md bg-muted/40 p-2 text-support">
        <p>{new Date(trigger.createdAt).toLocaleString()} · {trigger.snapshot.definition.name}</p>
        <p className="line-clamp-2 whitespace-pre-wrap">{trigger.snapshot.definition.prompt}</p>
        {wakeups._tag === 'Success' && wakeups.value.some(wakeup => wakeup.triggerId === trigger.id) ? <details>
          <summary>{chinese ? '合并的触发时间' : 'Combined occurrence times'}</summary>
          <ul className="space-y-1">{wakeups.value.filter(wakeup => wakeup.triggerId === trigger.id).map(wakeup => <li key={wakeup.id}>
            <time dateTime={new Date(wakeup.triggeredAt).toISOString()}>{new Date(wakeup.triggeredAt).toLocaleString(chinese ? 'zh-CN' : 'en')}</time>
          </li>)}</ul>
        </details> : null}
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => void prepare({ id: trigger.id, routineId: trigger.routineId, expectedRevision: trigger.expectedRevision })}>{chinese ? '准备 / 重试此任务' : 'Prepare / retry this task'}</Button>
        <Button variant="outline" size="sm" disabled={pending} onClick={() => void prepare({ id: trigger.id, routineId: trigger.routineId, expectedRevision: trigger.expectedRevision }, false, true)}>{chinese ? '运行此任务' : 'Run this task'}</Button>
      </li>)}
    </ul> : <p role="status" className="text-support">{history._tag === 'Failure' ? (chinese ? '无法加载触发历史。' : 'Could not load occurrence history.') : (chinese ? '正在加载…' : 'Loading…')}</p> : null}
    {message ? <p role={failed ? 'alert' : 'status'} className={`text-support ${failed ? 'text-destructive' : 'text-muted-foreground'}`}>{message}</p> : null}
  </li>
}
