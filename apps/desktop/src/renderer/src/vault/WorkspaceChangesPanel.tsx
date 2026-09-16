import { useAtomRefresh, useAtomSet, useAtomValue } from '@effect/atom-react'
import { Button } from '@folio/ui/components/ui/button'
import { useRef, useState } from 'react'
import type { SaveWorkspaceFiles, WorkspaceDiffInput } from '../../../shared/git-change'
import { useLocale } from '../preferences'
import { TaskRpcClient } from '../rpc/task-rpc'

/** Keeps file selection and retry identity stable across refreshes; viewing changes never saves them. */
export function WorkspaceChangesPanel(): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const query = TaskRpcClient.query('workspace.changes', {})
  const result = useAtomValue(query)
  const refresh = useAtomRefresh(query)
  const save = useAtomSet(TaskRpcClient.saveWorkspaceFiles, { mode: 'promise' })
  const [selection, setSelection] = useState<{ head: string; paths: string[] } | null>(null)
  const [submitted, setSubmitted] = useState<SaveWorkspaceFiles | null>(null)
  const [preview, setPreview] = useState<WorkspaceDiffInput | null>(null)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [savedCommit, setSavedCommit] = useState<string | null>(null)
  const inFlight = useRef(false)
  const view = result._tag === 'Success' ? result.value : null
  const validSelection = view !== null && selection !== null && selection.head === view.head
    && selection.paths.length > 0 && selection.paths.every(path => view.files.some(file => file.path === path && file.selectable))
  const canSave = validSelection && view?.registered && !view.pending.length

  /** A failed response retains the exact request; a retained server operation supplies its own original scope. */
  async function submit(retry?: SaveWorkspaceFiles): Promise<void> {
    if (inFlight.current) return
    const request: SaveWorkspaceFiles | null = retry ?? submitted ?? (canSave && selection ? { id: crypto.randomUUID(), expectedParent: selection.head,
      paths: [selection.paths[0]!, ...selection.paths.slice(1)] } : null)
    if (!request) return
    inFlight.current = true; setPending(true); setFailed(false); setSubmitted(request)
    try {
      const saved = await save({ payload: { input: request } })
      setSavedCommit(saved.commit)
      setSelection(null); setSubmitted(null)
      setPreview({ saveId: request.id, expectedParent: request.expectedParent, path: request.paths[0] })
    } catch { setFailed(true) }
    finally { inFlight.current = false; setPending(false); refresh() }
  }

  return <section className="mt-8 space-y-3" aria-labelledby="workspace-changes-title">
    <div className="flex items-center justify-between gap-3">
      <h2 id="workspace-changes-title" className="text-sm font-semibold">{chinese ? '文件变更' : 'File changes'}</h2>
      <Button variant="ghost" size="sm" disabled={pending} onClick={refresh}>{chinese ? '刷新变更' : 'Refresh changes'}</Button>
    </div>
    <p className="text-support text-muted-foreground">{chinese ? '选择要保存的磁盘文件。保存会产生提交，其他未选择的内容保留。' : 'Save selected files from disk as a commit. Unselected changes are retained.'}</p>
    {!view ? <p role="status" className="text-support text-muted-foreground">{result._tag === 'Failure'
      ? (chinese ? '无法读取变更，请刷新重试。' : 'Could not read changes. Refresh to retry.')
      : (chinese ? '正在读取变更…' : 'Loading changes…')}</p> : <>
      {!view.registered ? <p role="status" className="text-support text-muted-foreground">{chinese ? '当前提交尚未登记。请先处理未完成的保存或外部提交。' : 'The current commit is not registered. Resolve unfinished saves or external commits first.'}</p> : null}
      {view.pending.length ? <div className="space-y-2 rounded-lg border p-3">
        <h3 className="text-ui font-medium">{chinese ? '未完成的保存' : 'Unfinished saves'}</h3>
        {view.pending.map(item => <div key={item.id} className="space-y-2 border-t pt-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-support">
            <span>{chinese ? '原始文件快照已保留' : 'Original file snapshot retained'}</span>
            <Button variant="outline" size="sm" disabled={pending} onClick={() => void submit({ id: item.id, expectedParent: item.expectedParent, paths: item.paths })}>{chinese ? '重试这次保存' : 'Retry this save'}</Button>
          </div>
          {item.paths.map(path => <Button key={path} variant="ghost" size="sm" className="max-w-full justify-start whitespace-pre-wrap wrap-anywhere"
            onClick={() => setPreview({ path, expectedParent: item.expectedParent, saveId: item.id })}>{path}</Button>)}
        </div>)}
      </div> : null}
      {!view.files.length ? <p className="text-support text-muted-foreground">{chinese ? '没有待保存的文件变更。' : 'No file changes to save.'}</p>
        : <ul className="divide-y rounded-lg border">{view.files.map(file => <li key={file.path} className="flex items-center justify-between gap-3 px-3 py-2">
          <label className="flex min-w-0 items-center gap-2 text-ui">
            <input type="checkbox" checked={selection?.paths.includes(file.path) ?? false}
              disabled={pending || submitted !== null || !file.selectable || !view.registered || view.pending.length > 0}
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
      <Button size="sm" disabled={pending || (!submitted && !canSave)} onClick={() => void submit()}>{pending ? (chinese ? '正在保存…' : 'Saving…')
        : submitted ? (chinese ? '重试保存' : 'Retry save') : (chinese ? '保存所选文件' : 'Save selected files')}</Button>
      {selection && !submitted ? <Button variant="ghost" size="sm" disabled={pending} onClick={() => setSelection(null)}>{chinese ? '清除选择' : 'Clear selection'}</Button> : null}
      {failed && submitted && view && !view.pending.some(item => item.id === submitted.id) ? <Button variant="ghost" size="sm" disabled={pending}
        onClick={() => { setSubmitted(null); setSelection(null); setFailed(false); refresh() }}>{chinese ? '重新选择文件' : 'Choose files again'}</Button> : null}
    </div>
    {selection && selection.paths.length > 0 && !submitted && !validSelection ? <p role="status" className="text-support text-muted-foreground">{chinese ? '文件或基线已变化，请清除选择后重新选择。' : 'Files or baseline changed. Clear the selection and choose again.'}</p> : null}
    {failed ? <p role="alert" className="text-support text-destructive">{chinese ? '保存尚未确认，原操作已保留。请重试；存在冲突时需先检查文件。' : 'Save was not confirmed. The original request is retained. Retry, or inspect the files if there is a conflict.'}</p> : null}
    {savedCommit ? <p role="status" className="text-support text-muted-foreground">{chinese ? '已保存提交：' : 'Saved commit: '}{savedCommit.slice(0, 8)}</p> : null}
    {preview ? <WorkspaceDiff key={JSON.stringify(preview)} input={preview} onClose={() => setPreview(null)} /> : null}
  </section>
}

/** A saved preview names its retained operation; refresh cannot switch it to newer working-file content. */
function WorkspaceDiff({ input, onClose }: { input: WorkspaceDiffInput; onClose: () => void }): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const query = TaskRpcClient.query('workspace.diff', { input })
  const result = useAtomValue(query)
  const refresh = useAtomRefresh(query)
  return <section className="space-y-2 rounded-lg border p-3" aria-label={chinese ? '文件差异' : 'File diff'}>
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
