import { useAtomRefresh, useAtomValue } from '@effect/atom-react'
import { Button } from '@folio/ui/components/ui/button'
import { useEffect, useMemo, useRef, useState } from 'react'
import { WikiRpcClient } from '../rpc/wiki-rpc'
import { citedMessageIndex, readEvidenceConversation } from './raw-evidence'

/** Adjacent messages provide navigable context, not a claim that proximity defines a discussion. */
function EvidenceBody({ content, fragment, chinese }: { content: string; fragment: string | null; chinese: boolean }) {
  const conversation = useMemo(() => readEvidenceConversation(content), [content])
  const selected = conversation ? citedMessageIndex(conversation.messages, fragment) : -1
  const [before, setBefore] = useState(2)
  const [after, setAfter] = useState(2)
  const [showOriginal, setShowOriginal] = useState(false)
  const messagesRef = useRef<HTMLOListElement>(null)
  // Long preceding cards must not hide the cited message when the preview opens.
  useEffect(() => {
    const list = messagesRef.current
    const cited = list?.querySelector<HTMLElement>('[aria-current="true"]')
    if (list && cited) list.scrollTop = cited.offsetTop
  }, [content, fragment])
  if (!conversation || (fragment !== null && selected < 0)) return <>
    {fragment !== null && <p role="status" className="text-sm text-muted-foreground">{chinese
      ? '未能定位引用的消息，以下显示完整原文。' : 'The cited message could not be located. Showing the complete source.'}</p>}
    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-3 text-xs">{content}</pre>
  </>
  const start = Math.max(0, (selected < 0 ? 0 : selected) - before)
  const end = Math.min(conversation.messages.length, (selected < 0 ? 0 : selected) + after + 1)
  return <div className="space-y-3">
    <div><h3 className="text-sm font-medium">{conversation.title}</h3>
      <p className="text-xs text-muted-foreground">{chinese ? '时区：' : 'Time zone: '}{conversation.timeZone}</p></div>
    {start > 0 && <Button size="sm" variant="outline" onClick={() => setBefore(value => value + 5)}>
      {chinese ? '展开更早的消息' : 'Show earlier messages'}</Button>}
    <ol ref={messagesRef} aria-label={chinese ? '来源对话' : 'Source conversation'} className="relative max-h-96 space-y-2 overflow-auto">
      {conversation.messages.slice(start, end).map((message, offset) => {
        const cited = start + offset === selected
        return <li key={start + offset} aria-current={cited ? 'true' : undefined}
          className={`rounded border p-3 ${cited ? 'border-primary bg-primary/5' : 'border-border'}`}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className="break-all font-medium">{message.sender}</span>
            <time className="text-muted-foreground">{message.timestamp}</time>
            {cited && <span className="font-medium text-primary">{chinese ? '引用消息' : 'Cited message'}</span>}
          </div>
          <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-sm">{message.text}</pre>
        </li>
      })}
    </ol>
    {end < conversation.messages.length && <Button size="sm" variant="outline" onClick={() => setAfter(value => value + 5)}>
      {chinese ? '展开后续消息' : 'Show later messages'}</Button>}
    <div><Button size="sm" variant="ghost" aria-expanded={showOriginal} onClick={() => setShowOriginal(value => !value)}>
      {showOriginal ? chinese ? '收起完整原文' : 'Hide complete source' : chinese ? '查看完整原文' : 'View complete source'}
    </Button>
      {showOriginal && <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-3 text-xs">{content}</pre>}
    </div>
  </div>
}

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
          : result.value.kind === 'file' ? <EvidenceBody key={uri} content={result.value.content} fragment={result.value.fragment} chinese={chinese} />
            : <><p className="text-sm">{chinese ? '此文件在引用的 raw 范围内被删除。' : 'This file was deleted within the cited raw range.'}</p>
              <details open><summary className="text-sm">{chinese ? '删除差异' : 'Deletion diff'}</summary>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-3 text-xs">{result.value.diff}</pre></details>
              <details open><summary className="text-sm">{chinese ? '删除前内容' : 'Prior content'}</summary>
                <EvidenceBody key={uri} content={result.value.priorContent} fragment={result.value.fragment} chinese={chinese} /></details></>}
      </>}
  </section>
}
