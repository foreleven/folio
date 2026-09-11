import { useAtomRefresh, useAtomSet, useAtomValue } from '@effect/atom-react'
import { Button } from '@folio/ui/components/ui/button'
import { useEffect, useRef, useState } from 'react'
import type { SaveRunWikiFiles, SaveTaskWikiFiles, WorkspaceDiffInput, WorkspaceChangesView, GitSyncOperation } from '../../../shared/git-change'
import type { RunRecord } from '../../../shared/harness'
import { useLocale } from '../preferences'
import { TaskRpcClient } from '../rpc/task-rpc'

type TaskWikiIntent = {
  submitted?: SaveTaskWikiFiles | SaveRunWikiFiles
  sync?: { id: string; taskId: string; expectedSourceHead: string }
  reprepare?: { id: string; taskId: string; supersededId: string }
  conflict?: { vaultId: string; taskId: string; operationId: string; sourceSessionId: string; sessionId: string; runId: string }
}

/** Stable renderer intent is retry metadata only; it never contains file contents, secrets or paths outside wiki inputs. */
function readTaskWikiIntent(key: string): TaskWikiIntent {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.sessionStorage.getItem(key)
    if (!raw) return {}
    const value = JSON.parse(raw) as TaskWikiIntent
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

/** Best-effort session persistence keeps a lost RPC response retryable after a renderer refresh. */
function writeTaskWikiIntent(key: string, intent: TaskWikiIntent): void {
  if (typeof window === 'undefined') return
  try {
    if (Object.keys(intent).length === 0) window.sessionStorage.removeItem(key)
    else window.sessionStorage.setItem(key, JSON.stringify(intent))
  } catch {
    // Storage can be unavailable in private/browser test contexts; the server-side receipt remains authoritative.
  }
}

/** Explicitly saves selected Task wiki files; browsing and diffing never writes Git. */
export function TaskWikiChangesPanel({ vaultId, taskId }: { vaultId: string; taskId: string }): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const intentKey = `folio:task-wiki-intent:${vaultId}:${taskId}`
  const [persisted] = useState<TaskWikiIntent>(() => readTaskWikiIntent(intentKey))
  const changesQuery = TaskRpcClient.query('tasks.wikiChanges', { vaultId, taskId })
  const syncQuery = TaskRpcClient.query('tasks.pendingSynchronizations', { vaultId, taskId })
  const detailQuery = TaskRpcClient.query('tasks.get', { vaultId, id: taskId })
  const result = useAtomValue(changesQuery)
  const synchronizations = useAtomValue(syncQuery)
  const detail = useAtomValue(detailQuery)
  const refresh = useAtomRefresh(changesQuery)
  const refreshSynchronizations = useAtomRefresh(syncQuery)
  const save = useAtomSet(TaskRpcClient.saveTaskWikiFiles, { mode: 'promise' })
  const saveRun = useAtomSet(TaskRpcClient.saveRunWikiFiles, { mode: 'promise' })
  const confirmRun = useAtomSet(TaskRpcClient.confirmRunWikiUnchanged, { mode: 'promise' })
  const synchronize = useAtomSet(TaskRpcClient.synchronizeTaskWiki, { mode: 'promise' })
  const reprepare = useAtomSet(TaskRpcClient.reprepareTaskWiki, { mode: 'promise' })
  const startConflict = useAtomSet(TaskRpcClient.startConflictResolution, { mode: 'promise' })
  const resolveConflict = useAtomSet(TaskRpcClient.resolveTaskWikiConflict, { mode: 'promise' })
  const abortConflict = useAtomSet(TaskRpcClient.abortTaskWikiConflict, { mode: 'promise' })
  const [selection, setSelection] = useState<{ head: string; paths: string[] } | null>(null)
  const [submitted, setSubmitted] = useState<(SaveTaskWikiFiles | SaveRunWikiFiles) | null>(persisted.submitted ?? null)
  const [runSelection, setRunSelection] = useState<string[]>([])
  const [preview, setPreview] = useState<WorkspaceDiffInput | null>(null)
  const [syncIntent, setSyncIntent] = useState<{ id: string; taskId: string; expectedSourceHead: string } | null>(persisted.sync ?? null)
  const [reprepareIntent, setReprepareIntent] = useState<{ id: string; taskId: string; supersededId: string } | null>(persisted.reprepare ?? null)
  const [conflictIntent, setConflictIntent] = useState<{ vaultId: string; taskId: string; operationId: string; sourceSessionId: string; sessionId: string; runId: string } | null>(persisted.conflict ?? null)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [syncFailed, setSyncFailed] = useState(false)
  const [savedCommit, setSavedCommit] = useState<string | null>(null)
  const [syncMessage, setSyncMessage] = useState('')
  const inFlight = useRef(false)
  const syncInFlight = useRef(false)
  const view = result._tag === 'Success' ? result.value as WorkspaceChangesView : null
  const operations = synchronizations._tag === 'Success' ? synchronizations.value as readonly GitSyncOperation[] : []
  const validSelection = view !== null && selection !== null && selection.head === view.head
    && selection.paths.length > 0 && selection.paths.every(path => view.files.some(file => file.path === path && file.selectable))
  const runs = detail._tag === 'Success' ? (detail.value.runs ?? []) as readonly RunRecord[] : []
  const eligibleRuns = runs.filter(run => run.purpose !== 'conflict-resolution' && run.state === 'succeeded' && (run.syncState === 'pending' || run.syncState === 'failed'))
  const selectedRunIds = runSelection.filter(id => eligibleRuns.some(run => run.id === id))
  const canSave = validSelection && view?.registered && !view.pending.length && operations.length === 0
    && selectedRunIds.length === runSelection.length
  const operation = operations[0]
  const taskSessions = detail._tag === 'Success' ? detail.value.sessions : []
  const sourceSession = taskSessions.find(session => session.purpose === 'task')
  const conflictSession = operation ? taskSessions.find(session => session.purpose === 'conflict-resolution' && session.syncOperationId === operation.id) : undefined
  const conflictRun = conflictSession && detail._tag === 'Success'
    ? detail.value.runs.find(run => run.sessionId === conflictSession.id && run.purpose === 'conflict-resolution')
    : undefined
  const syncRequest = syncIntent ?? (operation ? { id: operation.id, taskId, expectedSourceHead: operation.sourceHead } : null)

  // Keep only retry identities in session storage. A refresh can restore a request,
  // while the durable main-process receipt still decides whether it is accepted.
  useEffect(() => {
    writeTaskWikiIntent(intentKey, {
      ...(submitted ? { submitted } : {}),
      ...(syncIntent ? { sync: syncIntent } : {}),
      ...(reprepareIntent ? { reprepare: reprepareIntent } : {}),
      ...(conflictIntent ? { conflict: conflictIntent } : {})
    })
  }, [conflictIntent, intentKey, reprepareIntent, submitted, syncIntent])

  /** Retains the exact save identity after a lost response; the server owns the filesystem root. */
  async function submit(retry?: SaveTaskWikiFiles | SaveRunWikiFiles): Promise<void> {
    if (inFlight.current) return
    const request: SaveTaskWikiFiles | SaveRunWikiFiles | null = retry ?? submitted ?? (canSave && selection ? selectedRunIds.length
      ? { id: crypto.randomUUID(), taskId, runIds: selectedRunIds as [string, ...string[]], expectedParent: selection.head, paths: selection.paths as [string, ...string[]] }
      : { id: crypto.randomUUID(), taskId, expectedParent: selection.head, paths: selection.paths as [string, ...string[]] }
      : null)
    if (!request) return
    inFlight.current = true; setPending(true); setFailed(false); setSubmitted(request)
    try {
      const saved = 'runIds' in request
        ? await saveRun({ payload: { vaultId, input: request } })
        : await save({ payload: { vaultId, input: request } })
      setSavedCommit(saved.commit)
      setSelection(null); setRunSelection([]); setSubmitted(null)
      setSyncIntent({ id: crypto.randomUUID(), taskId, expectedSourceHead: saved.commit })
      setSyncMessage(chinese ? '文件已保存为 Task 提交，可继续同步到 main。' : 'Files are saved as a Task commit; synchronize it to main when ready.')
    } catch { setFailed(true) }
    finally { inFlight.current = false; setPending(false); refresh(); refreshSynchronizations() }
  }

  /** Records a durable no-change receipt for one successful Run; the Run ID is the retry key. */
  async function confirmNoWikiChanges(run: RunRecord): Promise<void> {
    if (inFlight.current) return
    inFlight.current = true; setPending(true); setFailed(false)
    try {
      await confirmRun({ payload: { vaultId, input: { taskId, runId: run.id, expectedHead: run.baselineCommit } } })
      setSyncMessage(chinese ? `已确认 Run ${run.id.slice(0, 8)} 没有 wiki 变化。` : `Run ${run.id.slice(0, 8)} is confirmed to have no wiki changes.`)
    } catch { setFailed(true) }
    finally { inFlight.current = false; setPending(false); refresh(); refreshSynchronizations(); }
  }

  /** Publishes and aligns the durable operation; a retry reuses its stable operation ID. */
  async function sync(): Promise<void> {
    if (syncInFlight.current || !syncRequest) return
    syncInFlight.current = true; setPending(true); setSyncFailed(false); setSyncMessage('')
    try {
      const settled = await synchronize({ payload: { vaultId, input: syncRequest } })
      setSyncIntent(null)
      setSyncMessage(settled.state === 'aligned'
        ? (chinese ? '已发布并对齐到 main。' : 'Published and aligned with main.')
        : settled.state === 'conflict'
          ? (chinese ? '发生冲突，现场已保留在隔离目录。' : 'A conflict is isolated; the coordinator was retained.')
          : (chinese ? `同步状态：${settled.state}` : `Synchronization state: ${settled.state}`))
    } catch { setSyncFailed(true) }
    finally { syncInFlight.current = false; setPending(false); refresh(); refreshSynchronizations() }
  }

  /** Rebuilds stale prepared input on the current main without discarding its source journal. */
  async function retryOnNewMain(): Promise<void> {
    if (syncInFlight.current || (!reprepareIntent && (!operation || !['prepared', 'conflict', 'resolving'].includes(operation.state)))) return
    // The replacement edge is deterministic for the superseded operation. This means a refresh
    // before sessionStorage is flushed can still reconstruct the same id instead of creating a
    // second replacement operation for the same frozen source interval.
    const request = reprepareIntent ?? { id: `reprepare-${operation!.id}`, taskId, supersededId: operation!.id }
    setReprepareIntent(request)
    syncInFlight.current = true; setPending(true); setSyncFailed(false); setSyncMessage('')
    try {
      const replacement = await reprepare({ payload: { vaultId, input: request } })
      setReprepareIntent(null)
      setSyncIntent(null)
      setSyncMessage(chinese ? `已按新 main 重新准备：${replacement.id}` : `Reprepared on the current main: ${replacement.id}`)
    } catch { setSyncFailed(true) }
    finally { syncInFlight.current = false; setPending(false); refresh(); refreshSynchronizations() }
  }

  /** Starts the fixed-Agent conflict Run; the complete request is retained across a lost reply. */
  async function startConflictResolution(): Promise<void> {
    if (syncInFlight.current || (!conflictIntent && (!operation || operation.state !== 'conflict' || !sourceSession))) return
    const request = conflictIntent ?? {
      vaultId, taskId, operationId: operation!.id, sourceSessionId: sourceSession!.id,
      // Derive both identities from the operation so a refresh before sessionStorage is flushed
      // cannot dispatch a second conflict Run for the same isolated coordinator.
      sessionId: `conflict-session-${operation!.id}`, runId: `conflict-run-${operation!.id}`
    }
    setConflictIntent(request)
    syncInFlight.current = true; setPending(true); setSyncFailed(false); setSyncMessage('')
    try {
      const run = await startConflict({ payload: request })
      setConflictIntent(null)
      setSyncMessage(chinese ? `冲突解决 Run 已启动：${run.id}` : `Conflict-resolution Run started: ${run.id}`)
    } catch { setSyncFailed(true) }
    finally { syncInFlight.current = false; setPending(false); refresh(); refreshSynchronizations() }
  }

  /** Accepts a fully staged coordinator result; Folio performs the Git checks and sync. */
  async function acceptConflictResolution(): Promise<void> {
    if (syncInFlight.current || !operation || operation.state !== 'resolving') return
    syncInFlight.current = true; setPending(true); setSyncFailed(false); setSyncMessage('')
    try {
      const settled = await resolveConflict({ payload: { vaultId, taskId, id: operation.id } })
      setSyncMessage(chinese ? `冲突结果已接纳：${settled.state}` : `Conflict result accepted: ${settled.state}`)
    } catch { setSyncFailed(true) }
    finally { syncInFlight.current = false; setPending(false); refresh(); refreshSynchronizations() }
  }

  /** Explicitly discards only the isolated coordinator; main, Task and source history remain intact. */
  async function abortConflictResolution(): Promise<void> {
    if (syncInFlight.current || !operation || !['conflict', 'resolving'].includes(operation.state)) return
    syncInFlight.current = true; setPending(true); setSyncFailed(false); setSyncMessage('')
    try {
      await abortConflict({ payload: { vaultId, taskId, id: operation.id } })
      setConflictIntent(null)
      setSyncMessage(chinese ? '已放弃隔离冲突现场，原历史仍保留。' : 'The isolated conflict was aborted; original history is retained.')
    } catch { setSyncFailed(true) }
    finally { syncInFlight.current = false; setPending(false); refresh(); refreshSynchronizations() }
  }

  return <section className="space-y-3 rounded-lg border bg-muted/15 p-3" aria-label={chinese ? '任务文件变更' : 'Task file changes'}>
    <div className="flex items-center justify-between gap-3">
      <p className="text-support text-muted-foreground">{chinese ? 'Task wiki 文件' : 'Task wiki files'}</p>
      <Button variant="ghost" size="sm" disabled={pending} onClick={() => { refresh(); refreshSynchronizations() }}>{chinese ? '刷新变更' : 'Refresh changes'}</Button>
    </div>
    <p className="text-support text-muted-foreground">{chinese ? '只会保存你明确选择的 wiki/** 文件；保存和同步是两个独立步骤。' : 'Only explicitly selected wiki/** files are saved; saving and synchronization are separate steps.'}</p>
    {result._tag === 'Failure' ? <p role="alert" className="text-support">{chinese ? '无法读取 Task 文件变更，请刷新重试。' : 'Could not read Task file changes. Refresh to retry.'}</p>
      : !view ? <p role="status" className="text-support text-muted-foreground">{chinese ? '正在读取变更…' : 'Loading changes…'}</p> : <>
        {!view.registered ? <p role="status" className="text-support text-muted-foreground">{chinese ? 'Task 当前提交尚未登记，暂不能保存。' : 'The current Task commit is not registered; saving is unavailable.'}</p> : null}
        {view.pending.length ? <div className="space-y-2 rounded-lg border p-3">
          <h3 className="text-ui font-medium">{chinese ? '未完成的保存' : 'Unfinished saves'}</h3>
          {view.pending.map(item => <div key={item.id} className="space-y-2 border-t pt-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-support">
              <span>{chinese ? '原始快照已保留' : 'Original snapshot retained'}</span>
              <Button variant="outline" size="sm" disabled={pending} onClick={() => void submit({ id: item.id, taskId, expectedParent: item.expectedParent, paths: item.paths as [string, ...string[]] })}>{chinese ? '重试保存' : 'Retry save'}</Button>
            </div>
            {item.paths.map(path => <Button key={path} variant="ghost" size="sm" className="max-w-full justify-start whitespace-pre-wrap wrap-anywhere"
              onClick={() => setPreview({ path, expectedParent: item.expectedParent, saveId: item.id })}>{path}</Button>)}
          </div>)}
        </div> : null}
        {eligibleRuns.length ? <div className="space-y-2 rounded-lg border p-3">
          <h3 className="text-ui font-medium">{chinese ? 'Run 来源（可选）' : 'Run sources (optional)'}</h3>
          <p className="text-support text-muted-foreground">{chinese ? '选择后，保存的 wiki 文件会明确归属于这些成功 Run。没有文件变更时可单独确认。' : 'Selected successful Runs become the explicit source of the saved wiki files. Confirm a Run separately when it produced no files.'}</p>
          {eligibleRuns.map(run => <div key={run.id} className="flex flex-wrap items-center justify-between gap-2 text-support">
            <label className="flex min-w-0 items-center gap-2">
              <input type="checkbox" aria-label={`${chinese ? 'Run 来源' : 'Run source'} ${run.id}`} checked={runSelection.includes(run.id)} disabled={pending || view.pending.length > 0 || operations.length > 0}
                onChange={event => setRunSelection(current => event.target.checked ? [...current, run.id].sort() : current.filter(id => id !== run.id))} />
              <span className="truncate">{run.id} · {run.prompt}</span>
            </label>
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => void confirmNoWikiChanges(run)}>{chinese ? '确认无 wiki 变化' : 'Confirm no wiki changes'}</Button>
          </div>)}
        </div> : null}
        {!view.files.length ? <p className="text-support text-muted-foreground">{chinese ? '没有待保存的 Task 文件变更。' : 'No Task file changes to save.'}</p>
          : <ul className="divide-y rounded-lg border">{view.files.map(file => <li key={file.path} className="flex items-center justify-between gap-3 px-3 py-2">
            <label className="flex min-w-0 items-center gap-2 text-ui">
              <input type="checkbox" aria-label={file.path} checked={selection?.paths.includes(file.path) ?? false}
                disabled={pending || submitted !== null || !file.selectable || !view.registered || view.pending.length > 0 || operations.length > 0}
                onChange={event => setSelection(current => ({ head: current?.head ?? view.head, paths: event.target.checked
                  ? [...(current?.paths ?? []), file.path].sort() : (current?.paths ?? []).filter(path => path !== file.path) }))} />
              <span className="whitespace-pre-wrap wrap-anywhere">{file.path}</span>
            </label>
            <div className="flex shrink-0 items-center gap-2 text-support text-muted-foreground">
              <span>{!file.selectable ? (chinese ? '不支持' : 'Unsupported') : file.status === 'added' ? (chinese ? '新增' : 'Added')
                : file.status === 'deleted' ? (chinese ? '删除' : 'Deleted') : (chinese ? '修改' : 'Modified')}</span>
              <Button variant="ghost" size="sm" disabled={!file.selectable} aria-label={`${chinese ? '查看差异' : 'View diff'} ${file.path}`}
                onClick={() => setPreview({ path: file.path, expectedParent: view.head, saveId: null })}>{chinese ? '差异' : 'Diff'}</Button>
            </div>
          </li>)}</ul>}
      </>}
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" disabled={pending || (!submitted && !canSave)} onClick={() => void submit()}>{pending ? (chinese ? '处理中…' : 'Working…')
        : submitted ? (chinese ? '重试保存' : 'Retry save') : runSelection.length ? (chinese ? '保存并归属所选 Run' : 'Save and attribute to selected Runs') : (chinese ? '保存所选文件' : 'Save selected files')}</Button>
      {selection && !submitted ? <Button variant="ghost" size="sm" disabled={pending} onClick={() => setSelection(null)}>{chinese ? '清除选择' : 'Clear selection'}</Button> : null}
      {syncRequest ? <Button variant="outline" size="sm" disabled={pending} onClick={() => void sync()}>{operation ? (chinese ? '继续同步' : 'Continue sync') : (chinese ? '同步到 main' : 'Sync to main')}</Button> : null}
      {(reprepareIntent || (operation && ['prepared', 'conflict', 'resolving'].includes(operation.state))) && !syncIntent ? <Button variant="ghost" size="sm" disabled={pending} onClick={() => void retryOnNewMain()}>
        {operation?.state === 'prepared' || reprepareIntent?.supersededId === operation?.id
          ? (chinese ? 'main 已变化，重新准备' : 'Reprepare after main changed')
          : (chinese ? '在当前 main 上重新准备冲突' : 'Reprepare conflict on current main')}
      </Button> : null}
      {(operation?.state === 'conflict' || conflictIntent) && !syncIntent ? <>
        <Button variant="outline" size="sm" disabled={pending || (!sourceSession && !conflictIntent)} onClick={() => void startConflictResolution()}>
          {chinese ? '启动冲突解决 Run' : 'Start conflict-resolution Run'}
        </Button>
        {operation?.state === 'conflict' ? <Button variant="ghost" size="sm" disabled={pending} onClick={() => void abortConflictResolution()}>
          {chinese ? '放弃冲突现场' : 'Abort conflict'}
        </Button> : null}
      </> : null}
      {operation?.state === 'resolving' ? <>
        <Button variant="outline" size="sm" disabled={pending} onClick={() => void acceptConflictResolution()}>
          {chinese ? '接纳已暂存结果' : 'Accept staged resolution'}
        </Button>
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => void abortConflictResolution()}>
          {chinese ? '放弃冲突现场' : 'Abort conflict'}
        </Button>
      </> : null}
      {conflictIntent ? <p role="status" className="w-full text-support text-muted-foreground">
        {chinese ? '冲突解决请求未确认，重试会复用原请求。' : 'The conflict-resolution request is unconfirmed; retry will reuse the original request.'}
      </p> : null}
      {selection && !submitted && !validSelection ? <p role="status" className="w-full text-support text-muted-foreground">{chinese ? '文件或基线已变化，请清除选择后重新选择。' : 'Files or baseline changed. Clear the selection and choose again.'}</p> : null}
    </div>
    {failed ? <p role="alert" className="text-support text-destructive">{chinese ? '保存尚未确认，原操作已保留，请重试。' : 'Save was not confirmed; the original operation is retained. Retry it.'}</p> : null}
    {syncFailed ? <p role="alert" className="text-support text-destructive">{chinese ? '同步尚未确认，操作收据已保留，请刷新后重试。' : 'Synchronization was not confirmed; its receipt is retained. Refresh and retry.'}</p> : null}
    {syncMessage ? <p role="status" className="text-support">{syncMessage}</p> : null}
    {savedCommit ? <p role="status" className="text-support text-muted-foreground">{chinese ? 'Task 提交：' : 'Task commit: '}{savedCommit.slice(0, 8)}</p> : null}
    {operation && ['conflict', 'resolving'].includes(operation.state) ? <TaskWikiConflictDetails vaultId={vaultId} taskId={taskId} operationId={operation.id}
      conflictSessionId={conflictSession?.id} conflictRunId={conflictRun?.id} /> : null}
    {preview ? <TaskWikiDiff key={JSON.stringify(preview)} vaultId={vaultId} taskId={taskId} input={preview} onClose={() => setPreview(null)} /> : null}
  </section>
}

/** Displays bounded, non-sensitive conflict evidence without exposing the coordinator path. */
function TaskWikiConflictDetails({ vaultId, taskId, operationId, conflictSessionId, conflictRunId }: {
  vaultId: string; taskId: string; operationId: string; conflictSessionId?: string; conflictRunId?: string
}): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const query = TaskRpcClient.query('tasks.wikiConflictContext', { vaultId, taskId, id: operationId })
  const result = useAtomValue(query)
  if (result._tag !== 'Success') return <p role="status" className="text-support text-muted-foreground">
    {result._tag === 'Failure' ? (chinese ? '无法读取冲突详情，请刷新重试。' : 'Could not read conflict details. Refresh to retry.') : (chinese ? '正在读取冲突详情…' : 'Loading conflict details…')}
  </p>
  return <details className="space-y-2 rounded-lg border p-3" open>
    <summary className="text-ui font-medium">{chinese ? `冲突文件（${result.value.files.length}）` : `Conflicting files (${result.value.files.length})`}</summary>
    <ul className="list-disc pl-5 text-support">{result.value.files.map(path => <li key={path}>{path}</li>)}</ul>
    <p className="text-support text-muted-foreground">{chinese ? `共同基线：${result.value.commonBase}` : `Common base: ${result.value.commonBase}`}</p>
    <details><summary>{chinese ? 'main 侧差异' : 'Main-side diff'}</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{result.value.canonicalDiff}</pre></details>
    <details><summary>{chinese ? 'Task 侧差异' : 'Task-side diff'}</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{result.value.taskDiff}</pre></details>
    {conflictSessionId && conflictRunId ? <TaskWikiConflictRunHistory vaultId={vaultId} taskId={taskId} sessionId={conflictSessionId} runId={conflictRunId} /> : null}
  </details>
}

/** Embeds the conflict Run's durable projection so resolution context stays with its files. */
function TaskWikiConflictRunHistory({ vaultId, taskId, sessionId, runId }: { vaultId: string; taskId: string; sessionId: string; runId: string }): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const query = TaskRpcClient.query('tasks.sessionHistory', { vaultId, taskId, sessionId })
  const history = useAtomValue(query)
  if (history._tag !== 'Success') return <p role="status" className="text-support text-muted-foreground">
    {history._tag === 'Failure' ? (chinese ? '无法读取冲突解决消息，请刷新重试。' : 'Could not load conflict-resolution messages.') : (chinese ? '正在读取冲突解决消息…' : 'Loading conflict-resolution messages…')}
  </p>
  const messages = history.value.messages.filter(message => message.runId === runId && message.data.role !== 'user')
  const tools = history.value.tools.filter(tool => tool.runId === runId)
  if (!messages.length && !tools.length) return <p className="text-support text-muted-foreground">{chinese ? '冲突解决 Run 尚无消息。' : 'No conflict-resolution messages yet.'}</p>
  return <details className="space-y-2 rounded border p-2" open>
    <summary className="text-support font-medium">{chinese ? '冲突解决 Run 消息' : 'Conflict-resolution Run messages'}</summary>
    {messages.map(message => <p key={message.id} className="whitespace-pre-wrap break-words text-support">{displayConflictContent(message.data.content)}</p>)}
    {tools.map(tool => <details key={tool.id} className="text-support"><summary>{typeof tool.data.title === 'string' ? tool.data.title : tool.id}</summary>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(tool.data, null, 2)}</pre>
    </details>)}
  </details>
}

function displayConflictContent(content: unknown): string {
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content)
  return content.map(block => block && typeof block === 'object' && !Array.isArray(block) && typeof (block as { text?: unknown }).text === 'string'
    ? (block as { text: string }).text : JSON.stringify(block)).join('')
}

/** Reads a live or retained Task snapshot without interpreting diff text as markup. */
function TaskWikiDiff({ vaultId, taskId, input, onClose }: { vaultId: string; taskId: string; input: WorkspaceDiffInput; onClose: () => void }): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const query = TaskRpcClient.query('tasks.wikiDiff', { vaultId, taskId, input })
  const result = useAtomValue(query)
  const refresh = useAtomRefresh(query)
  return <section className="space-y-2 rounded-lg border p-3" aria-label={chinese ? 'Task 文件差异' : 'Task file diff'}>
    <div className="flex flex-wrap items-center justify-between gap-2 text-ui">
      <p className="whitespace-pre-wrap wrap-anywhere">{input.saveId ? (chinese ? '保存快照：' : 'Saved snapshot: ') : (chinese ? '磁盘变更：' : 'Disk changes: ')}{input.path}</p>
      <div className="flex gap-1"><Button variant="ghost" size="sm" onClick={refresh}>{chinese ? '刷新差异' : 'Refresh diff'}</Button>
        <Button variant="ghost" size="sm" onClick={onClose}>{chinese ? '关闭差异' : 'Close diff'}</Button></div>
    </div>
    {result._tag !== 'Success' ? <p role="status" className="text-support text-muted-foreground">{result._tag === 'Failure'
      ? (chinese ? '无法读取差异，文件或基线可能已变化。' : 'Could not read the diff. The file or baseline may have changed.')
      : (chinese ? '正在读取差异…' : 'Loading diff…')}</p>
      : result.value.kind === 'too-large' ? <p className="text-support text-muted-foreground">{chinese ? '文件较大，暂不提供行内预览。' : 'This file is too large for an inline preview.'}</p>
      : result.value.kind === 'binary' ? <p className="text-support text-muted-foreground">{chinese ? '二进制文件已变化。' : 'Binary file changed.'}</p>
      : result.value.kind === 'unchanged' ? <p className="text-support text-muted-foreground">{chinese ? '文件内容与基线相同。' : 'File content matches the baseline.'}</p>
      : <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-3 text-xs">{result.value.text}</pre>}
  </section>
}
