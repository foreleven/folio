import { useEditor, useEditorState, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { TableKit } from '@tiptap/extension-table'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Image from '@tiptap/extension-image'
import { useEffect, useState } from 'react'
import { Button } from '@folio/ui/components/ui/button'
import type { PageSummary } from '../../../shared/wiki'
import './wiki.css'

const extensions = [StarterKit.configure({ link: {
  openOnClick: false,
  // Explicit Page links need URI validation, not a process-global autolink protocol registration.
  isAllowedUri: (url, { defaultValidate }) => /^folio-page:[a-zA-Z0-9_-]+$/.test(url) || defaultValidate(url)
} }), Markdown, TableKit,
  TaskList, TaskItem.configure({ nested: true }), Image]
const blocks = [
  ['paragraph', 'Text', '文本'], ['h1', 'Heading 1', '标题 1'], ['h2', 'Heading 2', '标题 2'], ['h3', 'Heading 3', '标题 3'],
  ['bullet', 'Bullet list', '无序列表'], ['ordered', 'Numbered list', '有序列表'], ['task', 'To-do list', '待办列表'],
  ['quote', 'Quote', '引用'], ['code', 'Code', '代码块'], ['table', 'Table', '表格'], ['divider', 'Divider', '分隔线']
] as const

function insertBlock(editor: Editor, kind: string, slash = false) {
  const chain = editor.chain().focus()
  if (slash) {
    const { $from } = editor.state.selection
    chain.deleteRange({ from: $from.start(), to: $from.end() })
  }
  switch (kind) {
    case 'paragraph': chain.setParagraph().run(); break
    case 'h1': chain.toggleHeading({ level: 1 }).run(); break
    case 'h2': chain.toggleHeading({ level: 2 }).run(); break
    case 'h3': chain.toggleHeading({ level: 3 }).run(); break
    case 'bullet': chain.toggleBulletList().run(); break
    case 'ordered': chain.toggleOrderedList().run(); break
    case 'task': chain.toggleTaskList().run(); break
    case 'quote': chain.toggleBlockquote().run(); break
    case 'code': chain.toggleCodeBlock().run(); break
    case 'table': chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); break
    case 'divider': chain.setHorizontalRule().run(); break
  }
}

/** Markdown is the editing interchange format; unchanged imported source is not rewritten on mount. */
export function PageContentEditor({ value, onChange, chinese, pages = [], onNavigateLink }: {
  value: string; onChange: (value: string) => void; chinese: boolean; pages?: readonly PageSummary[]; onNavigateLink?: (href: string) => void
}) {
  const [source, setSource] = useState(false)
  const [slash, setSlash] = useState<string | null>(null)
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashPosition, setSlashPosition] = useState({ top: 0, left: 0 })
  const [insert, setInsert] = useState<'link' | 'image' | null>(null)
  const [url, setUrl] = useState('')
  const editor = useEditor({
    extensions, content: value, contentType: 'markdown',
    editorProps: { attributes: { class: 'wiki-prose focus:outline-none', 'aria-label': chinese ? '页面正文' : 'Page content' } },
    onUpdate: ({ editor }) => {
      onChange(editor.getMarkdown())
      const text = editor.state.selection.$from.parent.textContent
      setSlash(text.startsWith('/') ? text.slice(1).toLowerCase() : null)
      setSlashIndex(0)
      if (text.startsWith('/')) {
        const caret = editor.view.coordsAtPos(editor.state.selection.from)
        setSlashPosition({ top: Math.max(8, Math.min(caret.bottom + 6, window.innerHeight - 280)), left: Math.max(8, Math.min(caret.left, window.innerWidth - 272)) })
      }
    }
  })
  const inTable = useEditorState({ editor, selector: ({ editor }) => editor?.isActive('table') ?? false })
  // Source-mode edits and explicit reloads replace content without generating a save loop.
  useEffect(() => {
    if (editor && value !== editor.getMarkdown()) editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false })
  }, [editor, value])
  const slashBlocks = blocks.filter(([, en, zh]) => slash !== null && (en.toLowerCase().includes(slash) || zh.includes(slash)))
  if (!editor) return null
  return <div className="wiki-content-editor" onKeyDownCapture={event => {
    if (slash === null) return
    if (event.key === 'Escape') { event.preventDefault(); setSlash(null) }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation()
      setSlashIndex(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + slashBlocks.length) % Math.max(1, slashBlocks.length))
    }
    if (event.key === 'Enter' && slashBlocks[slashIndex]) {
      event.preventDefault(); event.stopPropagation(); insertBlock(editor, slashBlocks[slashIndex]![0], true); setSlash(null)
    }
  }} onClick={event => {
    const anchor = (event.target as HTMLElement).closest('a')
    if (!anchor || (!event.metaKey && !event.ctrlKey)) return
    event.preventDefault()
    const href = anchor.getAttribute('href') ?? ''
    if (/^https?:\/\//i.test(href)) window.open(href, '_blank', 'noopener,noreferrer')
    else onNavigateLink?.(href)
  }}>
    <div className="flex flex-wrap items-center gap-1 border-y py-2" aria-label={chinese ? '正文工具栏' : 'Content toolbar'}>
      <select aria-label={chinese ? '添加内容块' : 'Add block'} className="rounded px-2 py-1 text-sm" value="" disabled={source}
        onChange={event => insertBlock(editor, event.target.value)}>
        <option value="">{chinese ? '添加内容块' : 'Add block'}</option>
        {blocks.map(([id, en, zh]) => <option key={id} value={id}>{chinese ? zh : en}</option>)}
      </select>
      {[
        ['B', chinese ? '加粗' : 'Bold', () => editor.chain().focus().toggleBold().run()],
        ['I', chinese ? '斜体' : 'Italic', () => editor.chain().focus().toggleItalic().run()],
        ['S', chinese ? '删除线' : 'Strikethrough', () => editor.chain().focus().toggleStrike().run()],
        ['↶', chinese ? '撤销' : 'Undo', () => editor.chain().focus().undo().run()],
        ['↷', chinese ? '重做' : 'Redo', () => editor.chain().focus().redo().run()]
      ].map(([label, title, action]) => <Button key={String(title)} variant="ghost" size="sm" title={String(title)} aria-label={String(title)} disabled={source}
        onClick={action as () => void}>{String(label)}</Button>)}
      <Button variant="ghost" size="sm" disabled={source} onClick={() => { setInsert('link'); setUrl('') }}>{chinese ? '链接' : 'Link'}</Button>
      <Button variant="ghost" size="sm" disabled={source} onClick={() => { setInsert('image'); setUrl('') }}>{chinese ? '图片' : 'Image'}</Button>
      <select aria-label={chinese ? '插入页面链接' : 'Insert page link'} className="max-w-36 rounded px-2 py-1 text-sm" value="" disabled={source} onChange={event => {
        const page = pages.find(page => page.id === event.target.value)
        if (page) editor.chain().focus().insertContent({ type: 'text', text: page.title || (chinese ? '未命名' : 'Untitled'), marks: [{ type: 'link', attrs: { href: `folio-page:${page.id}` } }] }).run()
      }}><option value="">{chinese ? '页面链接' : 'Page link'}</option>{pages.filter(page => !page.trashed).map(page => <option key={page.id} value={page.id}>{page.title || page.id}</option>)}</select>
      <Button variant="ghost" size="sm" className="ml-auto" aria-pressed={source} onClick={() => setSource(!source)}>{source ? (chinese ? '编辑视图' : 'Editor') : 'Markdown'}</Button>
    </div>
    {inTable && !source && <div className="flex flex-wrap gap-1 border-b py-1">
      <Button variant="ghost" size="sm" onClick={() => editor.chain().focus().addRowAfter().run()}>{chinese ? '添加行' : 'Add row'}</Button>
      <Button variant="ghost" size="sm" onClick={() => editor.chain().focus().addColumnAfter().run()}>{chinese ? '添加列' : 'Add column'}</Button>
      <Button variant="ghost" size="sm" onClick={() => editor.chain().focus().deleteRow().run()}>{chinese ? '删除行' : 'Delete row'}</Button>
      <Button variant="ghost" size="sm" onClick={() => editor.chain().focus().deleteColumn().run()}>{chinese ? '删除列' : 'Delete column'}</Button>
      <Button variant="ghost" size="sm" onClick={() => editor.chain().focus().deleteTable().run()}>{chinese ? '删除表格' : 'Delete table'}</Button>
    </div>}
    {insert && <form className="flex gap-2 py-2" onSubmit={event => {
      event.preventDefault()
      if (!/^https?:\/\//i.test(url) || !URL.canParse(url)) return
      if (insert === 'image') editor.chain().focus().setImage({ src: url }).run()
      else if (editor.state.selection.empty) editor.chain().focus().insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] }).run()
      else editor.chain().focus().setLink({ href: url }).run()
      setInsert(null)
    }}>
      <input className="min-w-0 flex-1 rounded border px-2" type="url" autoFocus required placeholder="https://" aria-label="URL" value={url} onChange={event => setUrl(event.target.value)} />
      <Button size="sm" type="submit">{chinese ? '插入' : 'Insert'}</Button>
      <Button size="sm" variant="ghost" type="button" onClick={() => setInsert(null)}>{chinese ? '取消' : 'Cancel'}</Button>
    </form>}
    {slash !== null && !source && <div style={slashPosition} className="fixed z-50 max-h-64 w-64 overflow-auto rounded-lg border bg-popover p-2 shadow-md" role="listbox" aria-label={chinese ? '斜杠命令' : 'Slash commands'}>
      {slashBlocks.map(([id, en, zh], index) => <button key={id} type="button" role="option" aria-selected={slashIndex === index}
        className={`block w-full rounded px-3 py-2 text-left text-sm hover:bg-accent ${slashIndex === index ? 'bg-accent' : ''}`} onClick={() => { insertBlock(editor, id, true); setSlash(null) }}>{chinese ? zh : en}</button>)}
      <button className="px-3 py-1 text-xs text-muted-foreground" onClick={() => setSlash(null)}>{chinese ? '关闭' : 'Close'}</button>
    </div>}
    {source ? <textarea aria-label={chinese ? 'Markdown 源码' : 'Markdown source'} className="min-h-96 w-full resize-y bg-transparent py-5 font-mono text-sm outline-none"
      value={value} onChange={event => onChange(event.target.value)} /> : <EditorContent editor={editor} />}
    {!value && !source && <p className="text-sm text-muted-foreground">{chinese ? '开始书写，或输入 / 插入内容块…' : 'Start writing, or type / to insert a block…'}</p>}
  </div>
}
