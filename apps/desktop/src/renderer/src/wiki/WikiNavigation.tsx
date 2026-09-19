import { BookOpenIcon, ChevronRightIcon, ClockIcon, PlusIcon, Settings2Icon, StarIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import type { ObjectType, PageSummary } from '../../../shared/wiki'
import { inTrash, pageTree } from './wiki-navigation'

type View = 'all' | 'favorites' | 'recent' | 'trash' | `type:${string}`
const row = 'flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'
const selected = 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'

/** One navigation tree shared by the desktop sidebar and its narrow-window drawer. */
export function WikiNavigation({ chinese, active, pages, types, view, selectedId, typesOpen, disabled, onSelect, onOpen, onCreate, onView, onManageTypes }: {
  chinese: boolean
  active: boolean
  pages: readonly PageSummary[]
  types: readonly ObjectType[]
  view: View
  selectedId: string | null
  typesOpen: boolean
  disabled: boolean
  onSelect: () => void
  onOpen: (id: string) => Promise<boolean>
  onCreate: (parentId?: string | null) => Promise<boolean>
  onView: (view: View) => Promise<boolean>
  onManageTypes: () => Promise<boolean>
}) {
  const [collapsed, setCollapsed] = useState(() => new Set<string>())
  const [pagesOpen, setPagesOpen] = useState(true)
  const [objectTypesOpen, setObjectTypesOpen] = useState(true)
  const visible = pages.filter(page => !inTrash(page, pages))
  const tree = pageTree(visible).filter(({ page }) => {
    const seen = new Set<string>()
    let parent = page.parentId
    while (parent && !seen.has(parent)) {
      if (collapsed.has(parent)) return false
      seen.add(parent); parent = pages.find(page => page.id === parent)?.parentId ?? null
    }
    return true
  })
  // Close the mobile drawer only after navigation succeeds; conflicts retain the current editor.
  const select = async (action: Promise<boolean>) => { if (await action) onSelect() }
  const views = [
    { id: 'all', label: chinese ? '所有页面' : 'All pages', icon: BookOpenIcon },
    { id: 'recent', label: chinese ? '最近更新' : 'Recently updated', icon: ClockIcon },
    { id: 'favorites', label: chinese ? '收藏' : 'Favorites', icon: StarIcon }
  ] as const
  return <nav aria-label={chinese ? 'Wiki 导航' : 'Wiki navigation'} className="px-2 pb-4 text-sidebar-foreground">
    <div className="mb-1 mt-3 flex h-8 items-center px-2">
      <span className="flex-1 text-xs font-medium text-muted-foreground">Wiki</span>
      <button type="button" className="rounded p-1 hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring" aria-label={chinese ? '新建页面' : 'New page'} title={chinese ? '新建页面' : 'New page'} disabled={disabled} onClick={() => { void select(onCreate()) }}><PlusIcon className="size-4" /></button>
    </div>
    {views.map(({ id, label, icon: Icon }) => {
      const current = active && !selectedId && !typesOpen && view === id
      return <button type="button" key={id} className={`${row} ${current ? selected : ''}`} aria-current={current ? 'page' : undefined} disabled={disabled} onClick={() => { void select(onView(id)) }}><Icon className="size-4 shrink-0 text-muted-foreground" /><span>{label}</span></button>
    })}
    <button type="button" className="mt-4 flex h-8 w-full items-center gap-1 rounded px-2 text-xs font-medium text-muted-foreground hover:bg-sidebar-accent" aria-expanded={pagesOpen} onClick={() => setPagesOpen(value => !value)}><ChevronRightIcon className={`size-3 ${pagesOpen ? 'rotate-90' : ''}`} />{chinese ? '页面' : 'Pages'}</button>
    {pagesOpen && <div>
      {tree.map(({ page, depth }) => {
        const current = active && !typesOpen && selectedId === page.id
        const hasChildren = visible.some(child => child.parentId === page.id)
        const title = page.title || (chinese ? '未命名' : 'Untitled')
        return <div key={page.id} className={`group/page flex min-h-8 min-w-0 items-center rounded-md hover:bg-sidebar-accent ${current ? selected : ''}`} style={{ paddingLeft: Math.min(depth, 6) * 12 }}>
          {hasChildren ? <button type="button" className="shrink-0 rounded p-1 hover:bg-foreground/5" aria-expanded={!collapsed.has(page.id)} aria-label={`${chinese ? (collapsed.has(page.id) ? '展开' : '收起') : (collapsed.has(page.id) ? 'Expand' : 'Collapse')} ${title}`} onClick={() => setCollapsed(current => { const next = new Set(current); if (next.has(page.id)) next.delete(page.id); else next.add(page.id); return next })}><ChevronRightIcon className={`size-3 ${collapsed.has(page.id) ? '' : 'rotate-90'}`} /></button> : <span className="w-5 shrink-0" />}
          <button type="button" className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 text-left text-sm" title={title} aria-current={current ? 'page' : undefined} disabled={disabled} onClick={() => { void select(onOpen(page.id)) }}><span className="shrink-0">{page.icon || types.find(type => type.id === page.objectType)?.icon || '📄'}</span>{' '}<span className="truncate">{title}</span></button>
          <button type="button" className="mr-1 shrink-0 rounded p-1 opacity-0 hover:bg-foreground/5 focus-visible:opacity-100 group-hover/page:opacity-100" aria-label={`${chinese ? '添加子页面到' : 'Add subpage to'} ${title}`} disabled={disabled} onClick={() => { void select(onCreate(page.id)) }}><PlusIcon className="size-3" /></button>
        </div>
      })}
      {!tree.length && <p className="px-7 py-2 text-xs text-muted-foreground">{chinese ? '还没有页面' : 'No pages yet'}</p>}
    </div>}
    <button type="button" className="mt-4 flex h-8 w-full items-center gap-1 rounded px-2 text-xs font-medium text-muted-foreground hover:bg-sidebar-accent" aria-expanded={objectTypesOpen} onClick={() => setObjectTypesOpen(value => !value)}><ChevronRightIcon className={`size-3 ${objectTypesOpen ? 'rotate-90' : ''}`} />{chinese ? '对象类型' : 'Object types'}</button>
    {objectTypesOpen && <div>{types.map(type => {
      const current = active && !selectedId && !typesOpen && view === `type:${type.id}`
      return <button type="button" key={type.id} className={`${row} ${current ? selected : ''}`} aria-current={current ? 'page' : undefined} disabled={disabled} onClick={() => { void select(onView(`type:${type.id}`)) }}><span>{type.icon}</span>{' '}<span className="truncate">{type.name}</span><span className="ml-auto text-xs tabular-nums text-muted-foreground">{visible.filter(page => page.objectType === type.id).length}</span></button>
    })}</div>}
    <div className="mt-4 border-t border-sidebar-border/60 pt-2">
      <button type="button" className={`${row} text-muted-foreground ${active && typesOpen ? selected : ''}`} disabled={disabled} onClick={() => { void select(onManageTypes()) }}><Settings2Icon className="size-4" />{chinese ? '管理类型' : 'Manage types'}</button>
      <button type="button" className={`${row} text-muted-foreground ${active && !selectedId && !typesOpen && view === 'trash' ? selected : ''}`} disabled={disabled} onClick={() => { void select(onView('trash')) }}><Trash2Icon className="size-4" />{chinese ? '回收站' : 'Trash'}</button>
    </div>
  </nav>
}
