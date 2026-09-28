import { useAtomRefresh, useAtomValue } from '@effect/atom-react'
import { Button } from '@folio/ui/components/ui/button'
import { useEffect } from 'react'
import { WikiRpcClient } from '../rpc/wiki-rpc'

/** Projects display linked time-bearing assets without copying a timeline into Markdown. */
export function ProjectTimeline({ projectId, revision, chinese, onOpen }: {
  projectId: string; revision: string; chinese: boolean; onOpen: (id: string) => void
}): React.JSX.Element {
  const query = WikiRpcClient.query('wiki.projectTimeline', { id: projectId })
  const result = useAtomValue(query)
  const refresh = useAtomRefresh(query)
  useEffect(() => { refresh() }, [refresh, revision])
  return <section className="mt-8 border-t pt-4" aria-label={chinese ? '项目时间线' : 'Project timeline'}>
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="text-sm font-medium">{chinese ? '项目时间线' : 'Project timeline'}</h2>
      <Button variant="ghost" size="sm" onClick={refresh}>{chinese ? '刷新' : 'Refresh'}</Button>
    </div>
    {result._tag !== 'Success' ? <p role="status" className="text-sm text-muted-foreground">{result._tag === 'Failure'
      ? (chinese ? '无法读取时间线。' : 'Could not load the timeline.') : (chinese ? '正在读取时间线…' : 'Loading timeline…')}</p>
      : result.value.length === 0 ? <p className="text-sm text-muted-foreground">{chinese ? '还没有关联的事件。' : 'No linked events yet.'}</p>
      : <ol className="space-y-2">{result.value.map(entry => <li key={entry.id} className="flex items-start gap-3 text-sm">
        <time className="shrink-0 text-muted-foreground" dateTime={entry.occurredAt}>{entry.occurredAt.replace('T', ' ')}</time>
        <button className="text-left underline-offset-2 hover:underline" onClick={() => onOpen(entry.id)}>{entry.title || entry.objectType}</button>
        <span className="text-muted-foreground">{entry.objectType}</span>
      </li>)}</ol>}
  </section>
}
