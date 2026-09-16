import { useAtomRefresh, useAtomSet, useAtomValue } from '@effect/atom-react'
import { Button } from '@folio/ui/components/ui/button'
import { useEffect, useRef, useState } from 'react'
import type { Schema } from 'effect'
import { HarnessStoreError } from '../../../shared/harness'
import type { StartTaskRunInput } from '../../../shared/rpc/task-rpc'
import { useLocale } from '../preferences'
import { TaskRpcClient } from '../rpc/task-rpc'

/** Renders protocol content as text only; tool output never becomes executable HTML. */
function displayContent(content: Schema.Json | undefined): string {
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content)
  return content.map(block => block && typeof block === 'object' && !Array.isArray(block) && typeof block.text === 'string'
    ? block.text : JSON.stringify(block)).join('')
}

/** Explicit Prompt dispatch and durable history. Query refreshes never restore or resend execution. */
export function TaskConversation({ taskId, sessionId }: { taskId: string; sessionId: string }): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const detailQuery = TaskRpcClient.query('tasks.get', { id: taskId })
  const historyQuery = TaskRpcClient.query('tasks.sessionHistory', { taskId, sessionId })
  const detail = useAtomValue(detailQuery)
  const history = useAtomValue(historyQuery)
  const refreshDetail = useAtomRefresh(detailQuery)
  const refreshHistory = useAtomRefresh(historyQuery)
  const start = useAtomSet(TaskRpcClient.startRun, { mode: 'promise' })
  const inspect = useAtomSet(TaskRpcClient.inspectRun, { mode: 'promise' })
  const cancel = useAtomSet(TaskRpcClient.cancelRun, { mode: 'promise' })
  const [prompt, setPrompt] = useState('')
  const [recoveryId, setRecoveryId] = useState<string | null>(null)
  const [awaitingId, setAwaitingId] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [inspection, setInspection] = useState('')
  const [failed, setFailed] = useState(false)
  const [routineBusy, setRoutineBusy] = useState(false)
  const busy = useRef(false)
  const submitted = useRef<StartTaskRunInput | null>(null)
  const savedRuns = detail._tag === 'Success' ? detail.value.runs : []
  const requests = detail._tag === 'Success' ? detail.value.executions ?? [] : []
  const runs = [
    ...savedRuns.filter(run => !requests.some(request => request.id === run.id)),
    ...requests.map(request => ({ ...request, syncState: savedRuns.find(run => run.id === request.id)?.syncState }))
  ]
  const active = runs.find(run => run.state === 'queued' || run.state === 'preparing' || run.state === 'running')
  const awaiting = awaitingId !== null && !runs.some(run => run.id === awaitingId && run.endedAt !== null)

  const lastEnded = runs.filter(run => run.sessionId === sessionId && run.endedAt !== null).at(-1)?.id
  // A terminal ledger read can race the prior history query; fetch once more after the terminal
  // transition so stopping the live timer never leaves the last chunks absent from the view.
  useEffect(() => { refreshHistory() }, [lastEnded, refreshHistory])

  // Poll only during foreground execution or while its accepted record is catching up. Unmount
  // removes display timers; the main-process worker deliberately remains alive.
  useEffect(() => {
    if (!active && !awaiting) return
    const timer = setInterval(() => { refreshDetail(); refreshHistory() }, 1000)
    return () => clearInterval(timer)
  }, [active?.id, awaiting, refreshDetail, refreshHistory])

  /** Reuses a lost request's identity, while recovery requires a fresh user instruction. */
  async function submit(): Promise<void> {
    if (busy.current || active || !prompt.trim()) return
    const previous = submitted.current
    const input: StartTaskRunInput = previous?.prompt === prompt.trim() && previous.resumesRunId === recoveryId ? previous : {
      taskId, sessionId, id: crypto.randomUUID(), prompt: prompt.trim(),
      purpose: recoveryId ? 'recovery' : 'execution', resumesRunId: recoveryId
    }
    submitted.current = input
    busy.current = true
    setPending(true)
    setFailed(false)
    setRoutineBusy(false)
    setInspection('')
    setAwaitingId(input.id)
    try {
      await start({ payload: input })
      submitted.current = null
      setPrompt('')
      setRecoveryId(null)
    } catch (error) {
      setRoutineBusy(error instanceof HarnessStoreError && error.reason === 'routine-busy')
      setFailed(true); setAwaitingId(null)
    }
    finally { busy.current = false; setPending(false); refreshDetail(); refreshHistory() }
  }

  /** Cancellation waits for app-owned cleanup; it does not remove Run history or files. */
  async function stop(runId: string): Promise<void> {
    if (busy.current) return
    busy.current = true
    setPending(true)
    setFailed(false)
    setRoutineBusy(false)
    setInspection('')
    try { await cancel({ payload: { taskId, runId } }) }
    catch { setFailed(true) }
    finally { busy.current = false; setPending(false); refreshDetail(); refreshHistory() }
  }

  /** Checks stopped ownership only; this action neither connects an Agent nor sends a Prompt. */
  async function inspectRun(runId: string): Promise<void> {
    if (busy.current) return
    busy.current = true
    setPending(true)
    setFailed(false)
    setRoutineBusy(false)
    setInspection('')
    try {
      await inspect({ payload: { taskId, runId } })
      setInspection(chinese ? '旧执行已停止，记录已保留。可输入新的接续指令。' : 'Previous execution has stopped. Its history is retained; enter a new instruction to continue.')
    } catch {
      setInspection(chinese ? '尚不能确认旧执行已停止。仍存活的进程或不完整的记录会阻止接管。' : 'Could not confirm that execution stopped. A live process or incomplete records prevent takeover.')
    } finally { busy.current = false; setPending(false); refreshDetail(); refreshHistory() }
  }

  const labels = chinese
    ? { queued: '排队中', preparing: '准备中', running: '运行中', succeeded: '本轮结束', failed: '失败', interrupted: '已中断', cancelled: '已取消' }
    : { queued: 'Queued', preparing: 'Preparing', running: 'Running', succeeded: 'Turn ended', failed: 'Failed', interrupted: 'Interrupted', cancelled: 'Cancelled' }
  const syncLabels = chinese
    ? { 'not-required': '无需同步', pending: '待保存同步', syncing: '同步中', conflict: '同步冲突', completed: '已同步', failed: '同步失败' }
    : { 'not-required': 'No wiki changes', pending: 'Needs save/sync', syncing: 'Syncing', conflict: 'Sync conflict', completed: 'Synced', failed: 'Sync failed' }
  return <section className="space-y-3 rounded-lg border bg-muted/15 p-3" aria-label={chinese ? '会话内容' : 'Conversation'}>
    <div className="flex items-center justify-between">
      <p className="text-support text-muted-foreground">{chinese ? '运行记录与消息' : 'Runs and messages'}</p>
      <Button variant="ghost" size="sm" onClick={() => { refreshDetail(); refreshHistory() }}>{chinese ? '刷新消息' : 'Refresh messages'}</Button>
    </div>
    {history._tag === 'Failure' || detail._tag === 'Failure' ? <p role="alert">{chinese ? '无法加载执行记录，请刷新重试。' : 'Could not load execution history. Refresh to retry.'}</p> : null}
    {runs.filter(run => run.sessionId === sessionId).map(run => <article key={run.id} className="space-y-2 border-b pb-3 text-ui">
      <p className="whitespace-pre-wrap break-words font-medium">{run.prompt}</p>
      <p className="text-support text-muted-foreground">{labels[run.state]} · {run.syncState ? syncLabels[run.syncState] : chinese ? '改动尚未提交同步' : 'Changes have not been committed or synced'}</p>
      {history._tag === 'Success' ? history.value.messages.filter(message => message.runId === run.id && message.kind === 'message' && message.data.role !== 'user').map(message =>
        <div key={message.id} className="whitespace-pre-wrap break-words">{message.data.role === 'thought'
          ? <details><summary>{chinese ? '思考过程' : 'Reasoning'}</summary>{displayContent(message.data.content)}</details>
          : displayContent(message.data.content)}</div>) : null}
      {history._tag === 'Success' ? history.value.messages.filter(tool => tool.runId === run.id && tool.kind === 'tool_call').map(tool => <details key={tool.id} className="text-support">
        <summary>{typeof tool.data.title === 'string' ? tool.data.title : tool.id} · {String(tool.data.status ?? '')}</summary>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(tool.data, null, 2)}</pre>
      </details>) : null}
      {run.error ? <p role="alert" className="text-support text-destructive">{run.error}</p> : null}
      {['failed', 'interrupted', 'cancelled'].includes(run.state) ? <Button variant="ghost" size="sm" disabled={pending || !!active}
        onClick={() => { if (savedRuns.some(saved => saved.id === run.id)) setRecoveryId(run.id); else { setRecoveryId(null); setPrompt(run.prompt) } }}>{chinese ? '从这一轮继续' : 'Continue from this run'}</Button> : null}
    </article>)}
    {history._tag === 'Success' && history.value.messages.some(message => message.runId === null)
      ? <details className="text-ui" open><summary>{chinese ? '其他会话记录' : 'Other session history'}</summary>
        {history.value.messages.filter(message => message.runId === null && message.kind === 'message').map(message => <p key={message.id} className="whitespace-pre-wrap break-words">{displayContent(message.data.content)}</p>)}
        {history.value.messages.filter(tool => tool.runId === null && tool.kind === 'tool_call').map(tool => <pre key={tool.id} className="max-h-64 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(tool.data, null, 2)}</pre>)}
      </details> : null}
    <form className="space-y-2" onSubmit={event => { event.preventDefault(); void submit() }}>
      {recoveryId ? <p className="text-support">{chinese ? '请输入新的恢复指令，先检查已有进展；不会重放原指令。' : 'Enter a new recovery instruction that checks existing progress. The original prompt will not be replayed.'}
        <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setRecoveryId(null)}>{chinese ? '取消接续' : 'Clear recovery'}</Button></p> : null}
      <label className="block space-y-1 text-ui"><span>{chinese ? '指令' : 'Prompt'}</span>
        <textarea className="block min-h-20 w-full rounded-md border bg-background px-3 py-2" value={prompt}
          onChange={event => setPrompt(event.target.value)} disabled={pending} required />
      </label>
      <div className="flex justify-end gap-2">
        {active && savedRuns.some(run => run.id === active.id) ? <Button type="button" variant="ghost" disabled={pending} onClick={() => void inspectRun(active.id)}>{chinese ? '检查运行状态' : 'Inspect run'}</Button> : null}
        {active ? <Button type="button" variant="outline" disabled={pending} onClick={() => void stop(active.id)}>{active.state === 'queued' ? (chinese ? '取消排队' : 'Cancel queued run') : (chinese ? '停止运行' : 'Stop run')}</Button> : null}
        <Button type="submit" disabled={pending || !!active || !prompt.trim() || detail._tag !== 'Success'}>{chinese ? '发送' : 'Send'}</Button>
      </div>
      {inspection ? <p role="status" className="text-support">{inspection}</p> : null}
      {failed ? <p role="alert" className="text-support text-destructive">{routineBusy
        ? (chinese ? '同一 Routine 的另一个任务仍在执行或等待同步，请在处理完成后重试。' : 'Another Task from this Routine is running or awaiting synchronization. Resolve it before retrying.')
        : chinese ? '操作未能确认。请刷新记录；再次提交相同指令会沿用原请求。' : 'The operation could not be confirmed. Refresh history; retrying the same prompt reuses its request.'}</p> : null}
    </form>
  </section>
}
