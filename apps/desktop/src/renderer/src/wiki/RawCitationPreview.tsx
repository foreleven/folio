import { useAtomRefresh, useAtomValue } from '@effect/atom-react'
import { Button } from '@folio/ui/components/ui/button'
import { WikiRpcClient } from '../rpc/wiki-rpc'

/** Evidence stays pinned to the cited commit even when the daily raw file later changes. */
export function RawCitationPreview({ uri, chinese, onClose }: {
  uri: string; chinese: boolean; onClose: () => void
}): React.JSX.Element {
  const query = WikiRpcClient.query('wiki.rawCitation', { uri })
  const result = useAtomValue(query)
  const refresh = useAtomRefresh(query)
  return <section className="mt-6 space-y-3 rounded-lg border p-3" aria-label={chinese ? '原始证据' : 'Raw evidence'}>
    <div className="flex items-center justify-between gap-2">
      <h2 className="text-sm font-medium">{chinese ? '原始证据' : 'Raw evidence'}</h2>
      <div className="flex gap-1"><Button variant="ghost" size="sm" onClick={refresh}>{chinese ? '刷新' : 'Refresh'}</Button>
        <Button variant="ghost" size="sm" onClick={onClose}>{chinese ? '关闭' : 'Close'}</Button></div>
    </div>
    {result._tag !== 'Success' ? <p role="status" className="text-sm text-muted-foreground">{result._tag === 'Failure'
      ? (chinese ? '无法读取这条引用的证据。' : 'Could not read the cited evidence.') : (chinese ? '正在读取证据…' : 'Loading evidence…')}</p>
      : <>
        <p className="break-all font-mono text-xs text-muted-foreground">{result.value.commit.slice(0, 12)} · {result.value.path}
          {result.value.fragment ? ` #${result.value.fragment}` : ''}</p>
        {result.value.kind === 'too-large' ? <p className="text-sm text-muted-foreground">{chinese ? '证据文件过大，无法内联显示。' : 'The evidence file is too large for inline display.'}</p>
          : result.value.kind === 'file' ? <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-3 text-xs">{result.value.content}</pre>
            : <><p className="text-sm">{chinese ? '此文件在引用的 raw 范围内被删除。' : 'This file was deleted within the cited raw range.'}</p>
              <details open><summary className="text-sm">{chinese ? '删除差异' : 'Deletion diff'}</summary>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-3 text-xs">{result.value.diff}</pre></details>
              <details><summary className="text-sm">{chinese ? '删除前内容' : 'Prior content'}</summary>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-3 text-xs">{result.value.priorContent}</pre></details></>}
      </>}
  </section>
}
