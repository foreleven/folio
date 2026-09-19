import { useAtomRefresh, useAtomSet, useAtomValue } from '@effect/atom-react'
import { Button } from '@folio/ui/components/ui/button'
import { BookOpenIcon, FilePlusIcon, SearchIcon, StarIcon, ChevronRightIcon, MoreHorizontalIcon } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { newPageMetadata, type PageDocument, type PageMetadata } from '../../../shared/wiki'
import { useLocale } from '../preferences'
import { WikiRpcClient } from '../rpc/wiki-rpc'
import { ObjectTypesEditor } from './ObjectTypesEditor'
import { PageContentEditor } from './PageContentEditor'
import { PageProperties } from './PageProperties'
import { inTrash } from './wiki-navigation'
import { WikiNavigation } from './WikiNavigation'

type View = 'all' | 'favorites' | 'recent' | 'trash' | `type:${string}`
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Keeps one editor state alive while the window places navigation in its shared sidebar. */
export function WikiPanel({ active, onActivate, children }: {
  active: boolean
  onActivate: () => void
  children: (slots: { navigation: (onSelect: () => void) => React.ReactNode; content: React.ReactNode }) => React.ReactNode
}) {
  const chinese = useLocale() === 'zh-CN'
  const query = WikiRpcClient.query('wiki.snapshot', {})
  const result = useAtomValue(query)
  const refresh = useAtomRefresh(query)
  const read = useAtomSet(WikiRpcClient.readPage, { mode: 'promise' })
  const save = useAtomSet(WikiRpcClient.savePage, { mode: 'promise' })
  const saveTypes = useAtomSet(WikiRpcClient.saveTypes, { mode: 'promise' })
  const [view, setView] = useState<View>('all')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('updated')
  const [draft, setDraft] = useState<PageDocument | null>(null)
  const [saved, setSaved] = useState<PageDocument | null>(null)
  const [typesOpen, setTypesOpen] = useState(false)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [propertyFilter, setPropertyFilter] = useState('')
  const busy = useRef(false)
  const state = useRef({ draft, saved })
  useLayoutEffect(() => { state.current = { draft, saved } }, [draft, saved])
  const dirty = draft !== saved
  const snapshot = result._tag === 'Success' ? result.value : undefined
  const pages = snapshot?.pages ?? []
  const types = snapshot?.objectTypes ?? []
  const draftInTrash = draft ? inTrash(draft, pages) : false
  const untitled = chinese ? '未命名' : 'Untitled'
  const label = view.startsWith('type:') ? types.find(type => type.id === view.slice(5))?.name : ({ all: chinese ? '所有页面' : 'All pages', favorites: chinese ? '收藏' : 'Favorites', recent: chinese ? '最近更新' : 'Recently updated', trash: chinese ? '回收站' : 'Trash' } as Record<string, string>)[view]

  const persist = useCallback(async () => {
    const { draft, saved } = state.current
    if (!draft || draft === saved) return true
    if (busy.current) return false
    busy.current = true; setPending(true); setError('')
    try {
      const next = await save({ payload: { input: { metadata: draft, body: draft.body, expectedVersion: saved?.version ?? null } } })
      const current = state.current.draft
      const nextDraft = current === draft ? next : current ? { ...current, version: next.version, updatedAt: next.updatedAt } : null
      state.current = { draft: nextDraft, saved: next }
      setSaved(next); setDraft(nextDraft)
      refresh()
      return nextDraft === next
    } catch (error) { setError(errorText(error)); return false }
    finally { busy.current = false; setPending(false) }
  }, [save, refresh])
  useEffect(() => {
    if (!dirty || error || pending) return
    const timer = window.setTimeout(() => { void persist() }, 900)
    return () => window.clearTimeout(timer)
  }, [dirty, draft, error, pending, persist])
  useEffect(() => {
    const timer = window.setInterval(refresh, 5000)
    return () => window.clearInterval(timer)
  }, [refresh])
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => { if (state.current.draft !== state.current.saved) event.preventDefault() }
    window.addEventListener('beforeunload', leave)
    return () => window.removeEventListener('beforeunload', leave)
  }, [])
  const navigate = async (action: () => void | Promise<void>) => {
    if (busy.current) return false
    // A sidebar action from another module must reveal save/read errors in the retained editor.
    onActivate()
    if (!(await persist())) return false
    // A newer edit may have arrived while the preceding save was in flight.
    if (state.current.draft !== state.current.saved) return false
    busy.current = true; setPending(true); setError('')
    try { await action(); return true } catch (error) { setError(errorText(error)); return false }
    finally { busy.current = false; setPending(false) }
  }
  const open = (id: string) => navigate(async () => {
    const page = await read({ payload: { id } }); setDraft(page); setSaved(page); setTypesOpen(false)
  })
  const create = (parentId: string | null = null, duplicate = false) => navigate(() => {
    const metadata = newPageMetadata(crypto.randomUUID(), view.startsWith('type:') ? view.slice(5) : 'page', parentId)
    const page: PageDocument = { ...metadata, path: '', version: '', body: '' }
    if (duplicate && state.current.draft) Object.assign(page, state.current.draft, { id: metadata.id, path: '', version: '', title: `${state.current.draft.title || untitled} ${chinese ? '副本' : '(copy)'}`, createdAt: metadata.createdAt, updatedAt: metadata.updatedAt, favorite: false, trashed: false })
    setSaved(null); setDraft(page); setTypesOpen(false)
  })
  const chooseView = (next: View) => navigate(() => { setView(next); if (next === 'recent') setSort('updated'); setDraft(null); setSaved(null); setTypesOpen(false); setPropertyFilter('') })
  const edit = (next: PageMetadata) => setDraft(current => current ? { ...current, ...next } : current)
  const selectedType = view.startsWith('type:') ? types.find(type => type.id === view.slice(5)) : undefined
  const filtered = pages.filter(page => {
    if (inTrash(page, pages) !== (view === 'trash')) return false
    if (view === 'favorites' && !page.favorite) return false
    if (selectedType && page.objectType !== selectedType.id) return false
    if (propertyFilter && !JSON.stringify(page.properties).toLocaleLowerCase().includes(propertyFilter.toLocaleLowerCase())) return false
    return `${page.title} ${JSON.stringify(page.properties)}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())
  }).sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) : b.updatedAt.localeCompare(a.updatedAt))

  const navigation = (onSelect: () => void) => <WikiNavigation
    chinese={chinese} active={active} pages={pages} types={types} view={view}
    selectedId={draft?.id ?? null} typesOpen={typesOpen} disabled={pending || !snapshot}
    onSelect={onSelect} onOpen={open} onCreate={create} onView={chooseView}
    onManageTypes={() => navigate(() => setTypesOpen(true))}
  />
  const content = !snapshot ? <div role="status" className="p-8">{result._tag === 'Failure' ? (chinese ? '无法加载 Wiki。' : 'Could not load Wiki.') : (chinese ? '正在加载 Wiki…' : 'Loading Wiki…')}<Button variant="ghost" onClick={refresh}>{chinese ? '重试' : 'Retry'}</Button></div> : <div className="min-w-0 px-6 py-6 md:px-10 md:py-8">
      {error && <div role="alert" className="mb-4 rounded border border-destructive/30 p-3 text-sm text-destructive"><p>{error}</p><div className="mt-2 flex gap-2"><Button variant="outline" size="sm" disabled={pending} onClick={() => { void persist() }}>{chinese ? '重试保存' : 'Retry save'}</Button>{draft && saved && <Button variant="outline" size="sm" onClick={async () => { if (!window.confirm(chinese ? '放弃本地未保存的修改并重新加载？' : 'Discard unsaved local edits and reload?')) return; try { const next = await read({ payload: { id: draft.id } }); setDraft(next); setSaved(next); setError('') } catch (error) { setError(errorText(error)) } }}>{chinese ? '重新加载页面' : 'Reload page'}</Button>}</div></div>}
      {typesOpen ? <ObjectTypesEditor key={snapshot.typesVersion} initial={types} chinese={chinese} onClose={() => setTypesOpen(false)} onSave={async objectTypes => { busy.current = true; setPending(true); try { await saveTypes({ payload: { input: { objectTypes, expectedVersion: snapshot.typesVersion } } }); refresh() } finally { busy.current = false; setPending(false) } }} /> : draft ? <article className="mx-auto max-w-3xl">
        <div className="mb-5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <button onClick={() => { void chooseView(view) }}>Wiki</button><ChevronRightIcon className="size-3" />
          {draft.parentId && <><button onClick={() => { void open(draft.parentId!) }}>{pages.find(page => page.id === draft.parentId)?.title || untitled}</button><ChevronRightIcon className="size-3" /></>}
          <span className="truncate">{draft.title || untitled}</span>
          <span className="ml-auto" role="status">{pending ? (chinese ? '保存中…' : 'Saving…') : dirty ? (chinese ? '尚未保存' : 'Unsaved') : (chinese ? '已保存' : 'Saved')}</span>
          <Button size="sm" variant="ghost" aria-label={chinese ? '收藏页面' : 'Favorite page'} aria-pressed={draft.favorite} onClick={() => edit({ ...draft, favorite: !draft.favorite })}><StarIcon className={`size-4 ${draft.favorite ? 'fill-amber-400 text-amber-500' : ''}`} /></Button>
          <details className="relative"><summary aria-label={chinese ? '页面菜单' : 'Page menu'} className="cursor-pointer list-none p-2"><MoreHorizontalIcon className="size-4" /></summary>
            <div className="absolute right-0 z-20 min-w-40 rounded border bg-popover p-1 text-sm shadow-md" onClick={event => event.currentTarget.closest('details')?.removeAttribute('open')}>
              <button className="block w-full px-3 py-2 text-left hover:bg-accent" onClick={() => { void create(draft.id) }}>{chinese ? '添加子页面' : 'Add subpage'}</button>
              <button className="block w-full px-3 py-2 text-left hover:bg-accent" onClick={() => document.getElementById('page-parent')?.focus()}>{chinese ? '移动页面' : 'Move page'}</button>
              <button className="block w-full px-3 py-2 text-left hover:bg-accent" onClick={() => { void create(null, true) }}>{chinese ? '创建副本' : 'Duplicate'}</button>
              <button className="block w-full px-3 py-2 text-left hover:bg-accent" onClick={() => { const { body, path: _path, version: _version, ...metadata } = draft; const blob = new Blob([`---\n${JSON.stringify(metadata, null, 2)}\n---\n${body}`], { type: 'text/markdown' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${draft.title || 'Page'}.md`; a.click(); URL.revokeObjectURL(url) }}>{chinese ? '导出 Markdown' : 'Export Markdown'}</button>
              <button className="block w-full px-3 py-2 text-left text-destructive hover:bg-accent" onClick={() => edit({ ...draft, trashed: !draftInTrash, parentId: draftInTrash ? null : draft.parentId })}>{draftInTrash ? (chinese ? '恢复页面' : 'Restore page') : (chinese ? '移到回收站' : 'Move to trash')}</button>
            </div>
          </details>
          <Button size="sm" variant="outline" disabled={!dirty || pending} onClick={() => { void persist() }}>{chinese ? '保存' : 'Save'}</Button>
        </div>
        {draftInTrash && <p className="mb-4 rounded bg-muted p-3 text-sm">{chinese ? '此页面在回收站中。可通过页面菜单恢复。' : 'This page is in trash. Restore it from the page menu.'}</p>}
        {draft.cover && /^https?:\/\//i.test(draft.cover) && <img src={draft.cover} alt="" className="mb-5 h-48 w-full rounded-lg object-cover" />}
        <details className="mb-3 text-xs text-muted-foreground"><summary className="cursor-pointer">{chinese ? '设置封面' : 'Set cover'}</summary><input type="url" className="mt-2 w-full rounded border px-2 py-1" aria-label={chinese ? '封面地址' : 'Cover URL'} placeholder="https://" value={draft.cover} onChange={event => edit({ ...draft, cover: event.target.value })} /></details>
        <div className="mb-3 flex gap-2"><input className="w-16 rounded bg-transparent text-4xl" aria-label={chinese ? '页面图标' : 'Page icon'} value={draft.icon} placeholder={types.find(type => type.id === draft.objectType)?.icon || '📄'} onChange={event => edit({ ...draft, icon: event.target.value })} /></div>
        <input aria-label={chinese ? '页面标题' : 'Page title'} className="mb-6 w-full bg-transparent text-3xl font-bold tracking-tight outline-none md:text-4xl" placeholder={untitled} value={draft.title} onChange={event => edit({ ...draft, title: event.target.value })} />
        <PageProperties page={draft} pages={pages} objectTypes={types} onChange={edit} chinese={chinese} />
        <PageContentEditor key={draft.id} pages={pages} onNavigateLink={href => {
          if (href.startsWith('folio-page:')) { void open(href.slice('folio-page:'.length)); return }
          try {
            const path = decodeURIComponent(new URL(href, `https://wiki.local/${draft.path}`).pathname.slice(1))
            const target = pages.find(page => page.path === path)
            if (target) void open(target.id)
          } catch { /* Invalid imported links remain inert. */ }
        }} value={draft.body} onChange={body => setDraft(current => current ? { ...current, body } : current)} chinese={chinese} />
        {pages.some(page => page.parentId === draft.id && !inTrash(page, pages)) && <section className="mt-8 border-t pt-4"><h3 className="mb-2 text-sm text-muted-foreground">{chinese ? '子页面' : 'Subpages'}</h3>{pages.filter(page => page.parentId === draft.id && !inTrash(page, pages)).map(page => <button key={page.id} className="block py-1 text-sm underline" onClick={() => { void open(page.id) }}>{page.icon || '📄'} {page.title || untitled}</button>)}</section>}
      </article> : <section>
        <div className="mb-6 flex flex-wrap items-center gap-3"><h1 className="flex-1 text-2xl font-semibold">{label}</h1><Button disabled={pending} onClick={() => { void create() }}><FilePlusIcon className="size-4" />{chinese ? '新建页面' : 'New page'}</Button></div>
        <div className="mb-4 flex flex-wrap items-center gap-3"><label className="flex min-w-40 flex-1 items-center gap-2 rounded border px-3 py-2"><SearchIcon className="size-4 text-muted-foreground" /><input className="min-w-0 flex-1 bg-transparent text-sm outline-none" aria-label={chinese ? '搜索页面' : 'Search pages'} placeholder={chinese ? '搜索标题和属性…' : 'Search titles and properties…'} value={search} onChange={event => setSearch(event.target.value)} /></label>
          <select className="rounded border p-2 text-sm" aria-label={chinese ? '排序' : 'Sort'} value={sort} onChange={event => setSort(event.target.value)}><option value="updated">{chinese ? '最近更新' : 'Last edited'}</option><option value="title">{chinese ? '标题' : 'Title'}</option></select>
          <Button variant="ghost" size="sm" onClick={refresh}>{chinese ? '刷新' : 'Refresh'}</Button>

        </div>
        {selectedType && <input className="mb-4 w-full rounded border px-3 py-2 text-sm" aria-label={chinese ? '筛选属性' : 'Filter properties'} placeholder={chinese ? '按属性值筛选…' : 'Filter by property value…'} value={propertyFilter} onChange={event => setPropertyFilter(event.target.value)} />}
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b text-xs text-muted-foreground"><th className="py-3 font-normal">{chinese ? '名称' : 'Name'}</th>{selectedType ? selectedType.properties.map(field => <th className="px-3 py-3 font-normal" key={field.key}>{field.name}</th>) : <th className="px-3 py-3 font-normal">{chinese ? '类型' : 'Type'}</th>}<th className="py-3 text-right font-normal">{chinese ? '更新日期' : 'Last edited'}</th></tr></thead>
          <tbody>{filtered.map(page => <tr key={page.id} className="border-b hover:bg-muted/40"><td className="min-w-36 py-3"><button className="flex w-full items-center gap-2 text-left" onClick={() => { void open(page.id) }}><span>{page.icon || types.find(type => type.id === page.objectType)?.icon || '📄'}</span><span>{page.title || untitled}</span>{page.favorite && <StarIcon className="size-3 text-amber-500" />}</button></td>{selectedType ? selectedType.properties.map(field => { const value = page.properties[field.key]; return <td className="max-w-60 truncate px-3" key={field.key}>{Array.isArray(value) ? value.map(item => field.kind === 'relation' ? pages.find(page => page.id === item)?.title || item : item).join(', ') : typeof value === 'boolean' ? value ? '✓' : '—' : value ?? '—'}</td> }) : <td className="px-3 text-muted-foreground">{types.find(type => type.id === page.objectType)?.name || page.objectType}</td>}<td className="whitespace-nowrap text-right text-xs text-muted-foreground">{new Date(page.updatedAt).toLocaleDateString()}</td></tr>)}</tbody>
        </table></div>
        {!filtered.length && <div className="py-20 text-center"><BookOpenIcon className="mx-auto mb-4 size-8 text-muted-foreground" /><h2 className="font-medium">{search || propertyFilter ? (chinese ? '没有匹配的页面' : 'No matching pages') : (chinese ? '这里还没有页面' : 'No pages here yet')}</h2><p className="mt-2 text-sm text-muted-foreground">{chinese ? '新建一个页面，或将 Routine 的知识成果同步到 Wiki。' : 'Create a page, or synchronize knowledge from a Routine into the Wiki.'}</p></div>}
        {!!snapshot.issues.length && <details className="mt-6 rounded border p-3 text-sm"><summary className="cursor-pointer text-amber-600">{chinese ? '需要检查的文件' : 'Files needing attention'} ({snapshot.issues.length})</summary>{snapshot.issues.map(issue => <p className="mt-2" key={`${issue.path}:${issue.message}`}><code>{issue.path}</code> — {issue.message}</p>)}</details>}
      </section>}
    </div>
  return children({ navigation, content })
}
