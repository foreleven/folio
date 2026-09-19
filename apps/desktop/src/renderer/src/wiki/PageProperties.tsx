import type { ObjectType, PageMetadata, PageSummary, PropertyDefinition } from '../../../shared/wiki'

type Value = PageMetadata['properties'][string]
const inputClass = 'min-w-0 w-full rounded border border-transparent bg-transparent px-2 py-1.5 text-sm hover:bg-muted/50 focus:border-ring focus:outline-none'
function PropertyInput({ field, value, pages, onChange, chinese }: {
  field: PropertyDefinition; value: Value | undefined; pages: readonly PageSummary[]; onChange: (value: Value) => void; chinese: boolean
}) {
  if (field.kind === 'checkbox') return <input aria-label={field.name} type="checkbox" checked={value === true} onChange={event => onChange(event.target.checked)} />
  if (field.kind === 'select') return <select className={inputClass} aria-label={field.name} value={typeof value === 'string' ? value : ''} onChange={event => onChange(event.target.value)}>
    <option value="">{chinese ? '未设置' : 'Empty'}</option>{field.options.map(option => <option key={option}>{option}</option>)}
  </select>
  if (field.kind === 'relation' || (field.kind === 'multi-select' && field.options.length)) {
    const selected = Array.isArray(value) ? value : []
    const options = field.kind === 'relation' ? pages.filter(page => !page.trashed).map(page => ({ id: page.id, name: page.title || (chinese ? '未命名' : 'Untitled') })) : field.options.map(option => ({ id: option, name: option }))
    return <details aria-label={field.name} className="rounded px-2 py-1 text-sm"><summary className="cursor-pointer">{selected.map(id => options.find(option => option.id === id)?.name ?? id).join(', ') || (chinese ? '选择…' : 'Select…')}</summary>
      <div className="max-h-44 overflow-y-auto py-2">{options.map(option => <label key={option.id} className="flex gap-2 py-1"><input type="checkbox" checked={selected.includes(option.id)} onChange={event => onChange(event.target.checked ? [...selected, option.id] : selected.filter(id => id !== option.id))} />{option.name}</label>)}</div>
    </details>
  }
  if (field.kind === 'multi-select') return <input className={inputClass} aria-label={field.name} placeholder={chinese ? '标签，以逗号分隔' : 'Comma-separated tags'}
    value={Array.isArray(value) ? value.join(', ') : ''} onChange={event => onChange(event.target.value.split(',').map(item => item.trim()))} onBlur={() => { if (Array.isArray(value)) onChange([...new Set(value.filter(Boolean))]) }} />
  return <input className={inputClass} aria-label={field.name} type={field.kind === 'number' ? 'number' : field.kind === 'date' ? 'date' : field.kind === 'url' ? 'url' : 'text'}
    placeholder={chinese ? '未设置' : 'Empty'} value={typeof value === 'string' || typeof value === 'number' ? value : ''}
    onChange={event => onChange(field.kind === 'number' ? (event.target.value === '' ? null : Number(event.target.value)) : event.target.value)} />
}

export function PageProperties({ page, objectTypes, pages, onChange, chinese }: {
  page: PageMetadata; objectTypes: readonly ObjectType[]; pages: readonly PageSummary[]; onChange: (page: PageMetadata) => void; chinese: boolean
}) {
  const type = objectTypes.find(type => type.id === page.objectType)
  return <div className="mb-8 grid grid-cols-[minmax(6rem,9rem)_minmax(0,1fr)] items-center gap-x-4 gap-y-1 text-sm">
    <label className="text-muted-foreground" htmlFor="page-type">{chinese ? '对象类型' : 'Object type'}</label>
    <select id="page-type" className={inputClass} value={page.objectType} onChange={event => onChange({ ...page, objectType: event.target.value })}>
      {objectTypes.map(type => <option key={type.id} value={type.id}>{type.icon} {type.name}</option>)}
    </select>
    <label className="text-muted-foreground" htmlFor="page-parent">{chinese ? '所属页面' : 'Parent page'}</label>
    <select id="page-parent" className={inputClass} value={page.parentId ?? ''} onChange={event => onChange({ ...page, parentId: event.target.value || null })}>
      <option value="">{chinese ? 'Wiki 根目录' : 'Wiki root'}</option>
      {pages.filter(candidate => candidate.id !== page.id && !candidate.trashed).map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.icon} {candidate.title || (chinese ? '未命名' : 'Untitled')}</option>)}
    </select>
    {type?.properties.map(field => <div key={field.key} className="contents">
      <span className="text-muted-foreground">{field.name}</span>
      <PropertyInput field={field} value={page.properties[field.key]} pages={pages} chinese={chinese} onChange={value => onChange({ ...page, properties: { ...page.properties, [field.key]: value } })} />
    </div>)}
  </div>
}
