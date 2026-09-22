import { useAtomSet, useAtomValue } from '@effect/atom-react'
import { Badge } from '@folio/ui/components/ui/badge'
import { Button } from '@folio/ui/components/ui/button'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TaskFeedCursor, TaskFeedPage } from '../../../shared/rpc/task-rpc'
import { routineDateAt } from '../../../shared/routine'
import { useLocale } from '../preferences'
import { ConfigRpcClient } from '../rpc/config-rpc'
import { TaskRpcClient } from '../rpc/task-rpc'

type Entry = TaskFeedPage['entries'][number]

/** Read-only Task history. Refetching the head updates live rows without moving older cursors. */
export function TaskFeed(): React.JSX.Element {
  const chinese = useLocale() === 'zh-CN'
  const config = useAtomValue(ConfigRpcClient.watch)
  const request = useAtomSet(TaskRpcClient.feed, { mode: 'promise' })
  const requestRef = useRef(request)
  useEffect(() => { requestRef.current = request }, [request])
  const busy = useRef(false)
  const loaded = useRef(false)
  const loadedCursors = useRef<TaskFeedCursor[]>([])
  const [hasLoaded, setHasLoaded] = useState(false)
  const [entries, setEntries] = useState<readonly Entry[]>([])
  const [nextCursor, setNextCursor] = useState<TaskFeedCursor | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const sentinel = useRef<HTMLDivElement>(null)

  const load = useCallback(async (cursor: TaskFeedCursor | null, refreshLoaded = false) => {
    if (busy.current) return
    busy.current = true
    if (!loaded.current || !refreshLoaded && cursor) setLoading(true)
    try {
      const pages = await Promise.all((refreshLoaded ? [null, ...loadedCursors.current] : [cursor])
        .map(position => requestRef.current({ payload: { cursor: position } })))
      setEntries(previous => {
        const byId = new Map(previous.map(entry => [entry.task.id, entry]))
        for (const page of pages) for (const entry of page.entries) byId.set(entry.task.id, entry)
        return [...byId.values()].sort((a, b) => b.task.createdAt - a.task.createdAt || b.task.id.localeCompare(a.task.id))
      })
      if (!refreshLoaded) {
        if (cursor) loadedCursors.current.push(cursor)
        setNextCursor(pages[0]!.nextCursor)
      }
      loaded.current = true
      setHasLoaded(true)
      setError(false)
    } catch {
      setError(true)
    } finally {
      busy.current = false
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(null)
    const timer = setInterval(() => { void load(null, loaded.current) }, 4000)
    return () => clearInterval(timer)
  }, [load])

  useEffect(() => {
    if (!nextCursor || !sentinel.current || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(observed => {
      if (observed.some(item => item.isIntersecting)) void load(nextCursor)
    }, { rootMargin: '200px' })
    observer.observe(sentinel.current)
    return () => observer.disconnect()
  }, [nextCursor, load])

  const timeZone = config._tag === 'Success' ? config.value.timeZone : null
  const groups = new Map<string, Entry[]>()
  if (timeZone) for (const entry of entries) {
    const date = routineDateAt(entry.task.createdAt, timeZone)
    const group = groups.get(date) ?? []
    group.push(entry)
    groups.set(date, group)
  }

  return <section aria-labelledby="task-feed-title" className="space-y-6">
    <header>
      <p className="text-support font-medium text-primary">{chinese ? '知识库动态' : 'VAULT ACTIVITY'}</p>
      <h3 id="task-feed-title" className="mt-1 text-xl leading-7 font-semibold">{chinese ? '任务发现与结果' : 'Task discoveries and results'}</h3>
    </header>
    {config._tag === 'Failure' ? <p role="alert" className="text-support text-destructive">{chinese ? '无法读取显示时区。' : 'Could not load the display time zone.'}</p> : null}
    {!timeZone && config._tag !== 'Failure' ? <p role="status" className="text-support text-muted-foreground">{chinese ? '正在加载时区…' : 'Loading time zone…'}</p> : null}
    {timeZone && [...groups].map(([date, items]) => <section key={date} aria-label={date} className="space-y-3">
      <h4 className="border-b pb-2 text-support font-semibold text-muted-foreground">{new Intl.DateTimeFormat(chinese ? 'zh-CN' : 'en-US', {
        timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short'
      }).format(new Date(`${date}T12:00:00Z`))}</h4>
      <ol className="space-y-2">{items.map(entry => <li key={entry.task.id}><FeedEntry entry={entry} timeZone={timeZone} chinese={chinese} /></li>)}</ol>
    </section>)}
    {loading && !hasLoaded ? <p role="status" className="text-support text-muted-foreground">{chinese ? '正在加载任务…' : 'Loading Tasks…'}</p> : null}
    {hasLoaded && entries.length === 0 ? <p className="rounded-lg border border-dashed p-8 text-center text-support text-muted-foreground">{chinese ? '暂无任务记录。' : 'No Tasks yet.'}</p> : null}
    {error ? <p role="alert" className="text-support text-destructive">{chinese ? '读取任务失败，请重试。' : 'Could not load Tasks.'} <Button size="sm" variant="outline" onClick={() => void load(null, loaded.current)}>{chinese ? '重试' : 'Retry'}</Button></p> : null}
    {nextCursor ? <div ref={sentinel} className="flex justify-center py-2"><Button size="sm" variant="ghost" disabled={loading} onClick={() => void load(nextCursor)}>{loading ? (chinese ? '加载中…' : 'Loading…') : chinese ? '加载更早任务' : 'Load earlier Tasks'}</Button></div> : null}
  </section>
}

function contentText(content: readonly unknown[]): string {
  return content.map(block => block && typeof block === 'object' && !Array.isArray(block) && 'text' in block && typeof block.text === 'string'
    ? block.text : JSON.stringify(block)).join('')
}

function FeedEntry({ entry, timeZone, chinese }: { entry: Entry; timeZone: string; chinese: boolean }): React.JSX.Element {
  const { task, latestRun, routineName, schedule } = entry
  const summary = task.summary
  const status = task.type === 'ingestion' ? task.receipt.state
    : task.state === 'cancelled' ? 'cancelled' : latestRun?.state ?? (task.state === 'completed' ? 'succeeded' : 'pending')
  const active = ['pending', 'queued', 'preparing', 'running'].includes(status)
  const compact = active || (summary?.type === 'ingestion' && summary.outcome === 'succeeded' && !summary.rawsChanged)
  const title = routineName ?? (task.type === 'agent' ? task.configuration.goal : `${task.configuration.integrationId} / ${task.configuration.resourceId}`)
  const created = new Intl.DateTimeFormat(chinese ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit', timeZone }).format(task.createdAt)
  const statusName: Record<string, string> = chinese
    ? { pending: '待处理', queued: '排队中', preparing: '准备中', running: '执行中', succeeded: '已完成', failed: '失败', interrupted: '已中断', cancelled: '已取消', conflict: '冲突' }
    : { pending: 'Pending', queued: 'Queued', preparing: 'Preparing', running: 'Running', succeeded: 'Succeeded', failed: 'Failed', interrupted: 'Interrupted', cancelled: 'Cancelled', conflict: 'Conflict' }
  const discovery = summary?.type === 'agent' && summary.discovery ? contentText(summary.discovery.content) : null
  const sourceWindow = summary?.type === 'ingestion' ? summary : schedule
  return <article className={`rounded-lg border bg-card ${compact ? 'px-4 py-3' : 'p-4'}`}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="text-support text-muted-foreground">{task.type === 'ingestion' ? 'Ingestion' : 'Agent'} · {created}{routineName ? ` · ${routineName}` : ''}</p>
        <h5 className="mt-0.5 line-clamp-1 text-ui font-medium" title={title}>{title}</h5>
      </div>
      <Badge variant={status === 'succeeded' ? 'success' : active ? 'progress' : ['failed', 'interrupted', 'conflict'].includes(status) ? 'destructive' : 'outline'}>{statusName[status]}</Badge>
    </div>
    {sourceWindow ? <p className="mt-2 text-support text-muted-foreground">{new Intl.DateTimeFormat(chinese ? 'zh-CN' : 'en-US', {
      timeZone: sourceWindow.timeZone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    }).format(sourceWindow.windowStart)} → {new Intl.DateTimeFormat(chinese ? 'zh-CN' : 'en-US', {
      timeZone: sourceWindow.timeZone, hour: '2-digit', minute: '2-digit'
    }).format(sourceWindow.windowEnd)} · {sourceWindow.timeZone}</p> : null}
    {!compact && discovery ? <p className="mt-3 line-clamp-4 whitespace-pre-wrap break-words text-ui">{discovery}{summary?.type === 'agent' && summary.discovery?.incomplete ? (chinese ? '（未完整完成）' : ' (incomplete)') : ''}</p> : null}
    {!compact && summary?.type === 'ingestion' && summary.outcome === 'succeeded' ? <p className="mt-3 text-support">{chinese ? `更新 ${summary.changedFileCount} 个 raw 文件` : `${summary.changedFileCount} raw file(s) changed`}</p> : null}
    {compact && summary?.type === 'ingestion' && !summary.rawsChanged ? <p className="mt-1 text-support text-muted-foreground">{chinese ? '没有 raw 文件变化' : 'No raw file changes'}</p> : null}
    {!compact && (summary?.error || (task.type === 'ingestion' ? task.receipt.error : latestRun?.error)) ? <p className="mt-3 line-clamp-3 text-support text-destructive">{summary?.error || (task.type === 'ingestion' ? task.receipt.error : latestRun?.error)}</p> : null}
    {!compact && summary ? <p className="mt-3 text-support text-muted-foreground">{chinese ? '发布' : 'Publication'}: {summary.publication.state}
      {summary.publication.saveOperationId ? ` · ${chinese ? '保存' : 'Save'} ${summary.publication.saveOperationId.slice(0, 8)}` : ''}
      {summary.publication.synchronizationId ? ` · ${chinese ? '同步' : 'Sync'} ${summary.publication.synchronizationId.slice(0, 8)}` : ''}
    </p> : null}
  </article>
}
