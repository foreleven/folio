import { useState } from 'react'
import { Button } from '@folio/ui/components/ui/button'
import type { ObjectType, OptionColor, PropertyKind, StatusGroup } from '../../../shared/wiki'
const kinds: PropertyKind[] = ['text', 'number', 'checkbox', 'date', 'datetime', 'url', 'email', 'phone', 'select', 'multi-select', 'status']
const colors: OptionColor[] = ['default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red']
const groups: StatusGroup[] = ['not_started', 'in_progress', 'complete']
const fieldClass = 'rounded border bg-background px-2 py-1.5 text-sm'

export function ObjectTypesEditor({ initial, onSave, onClose, chinese }: {
  initial: readonly ObjectType[]; onSave: (types: readonly ObjectType[]) => Promise<void>; onClose: () => void; chinese: boolean
}) {
  const [types, setTypes] = useState(initial)
  const [selected, setSelected] = useState(initial[0]!.id)
  const [name, setName] = useState('')
  const [newKind, setNewKind] = useState<PropertyKind>('text')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const current = types.find(type => type.id === selected)!
  const update = (next: ObjectType) => setTypes(types.map(type => type.id === selected ? next : type))
  return <section aria-label={chinese ? '管理对象类型' : 'Manage object types'} className="mx-auto max-w-4xl space-y-6">
    <header className="flex items-center gap-2"><h2 className="flex-1 text-xl font-semibold">{chinese ? '对象类型' : 'Object types'}</h2>
      <Button variant="ghost" disabled={pending} onClick={onClose}>{chinese ? '取消' : 'Cancel'}</Button>
      <Button disabled={pending} onClick={async () => { setPending(true); setError(''); try { await onSave(types); onClose() } catch (error) { setError(String(error)) } finally { setPending(false) } }}>{chinese ? '保存类型' : 'Save types'}</Button>
    </header>
    <fieldset disabled={pending} className="space-y-6">
    <p className="text-sm text-muted-foreground">{chinese ? '属性的键和类型创建后保持不变；使用中的选项和属性不能删除。' : 'Property keys and kinds stay fixed after creation. Options and properties in use cannot be removed.'}</p>
    <div className="flex flex-wrap gap-2">{types.map(type => <Button key={type.id} variant={type.id === selected ? 'secondary' : 'ghost'} onClick={() => setSelected(type.id)}>{type.icon} {type.name}</Button>)}</div>
    <form className="flex gap-2" onSubmit={event => { event.preventDefault(); if (!name.trim()) return; const id = `type_${crypto.randomUUID().slice(0, 8)}`; setTypes([...types, { id, name: name.trim(), icon: '📄', properties: [] }]); setSelected(id); setName('') }}>
      <input aria-label={chinese ? '新类型名称' : 'New type name'} className={fieldClass} value={name} onChange={event => setName(event.target.value)} placeholder={chinese ? '例如：读书笔记' : 'For example: Book'} />
      <Button type="submit" variant="outline">{chinese ? '新建类型' : 'New type'}</Button>
    </form>
    <div className="rounded-lg border p-4">
      <div className="flex flex-wrap gap-3">
        <label className="text-sm">{chinese ? '图标' : 'Icon'}<input aria-label={chinese ? '类型图标' : 'Type icon'} className={`${fieldClass} ml-2 w-16`} value={current.icon} onChange={event => update({ ...current, icon: event.target.value })} /></label>
        <label className="text-sm">{chinese ? '名称' : 'Name'}<input aria-label={chinese ? '类型名称' : 'Type name'} className={`${fieldClass} ml-2`} value={current.name} onChange={event => update({ ...current, name: event.target.value })} /></label>
        {current.id !== 'page' && <Button variant="ghost" onClick={() => { setTypes(types.filter(type => type.id !== current.id)); setSelected('page') }}>{chinese ? '删除类型' : 'Delete type'}</Button>}
      </div>
      <div className="mt-5 space-y-3">{current.properties.map((field, index) => <div key={field.key} className="flex flex-wrap items-center gap-2 border-t pt-3">
        <input className={fieldClass} aria-label={`${chinese ? '属性名称' : 'Property name'} ${index + 1}`} value={field.name} onChange={event => update({ ...current, properties: current.properties.map(item => item.key === field.key ? { ...item, name: event.target.value } : item) })} />
        <span className="rounded bg-muted px-2 py-1 text-xs">{field.kind}</span>
        <Button variant="ghost" onClick={() => update({ ...current, properties: current.properties.filter(item => item.key !== field.key) })}>{chinese ? '移除' : 'Remove'}</Button>
        {['select', 'multi-select', 'status'].includes(field.kind) && <div className="w-full space-y-2 pl-2">
          {field.options.map(option => <div key={option.id} className="flex flex-wrap items-center gap-2">
            <input className={fieldClass} aria-label={`${field.name} option ${option.id}`} value={option.name} onChange={event => update({ ...current, properties: current.properties.map(item => item.key === field.key ? { ...item, options: item.options.map(candidate => candidate.id === option.id ? { ...candidate, name: event.target.value } : candidate) } : item) })} />
            <select className={fieldClass} aria-label={`${field.name} color ${option.id}`} value={option.color ?? 'default'} onChange={event => update({ ...current, properties: current.properties.map(item => item.key === field.key ? { ...item, options: item.options.map(candidate => candidate.id === option.id ? { ...candidate, color: event.target.value as OptionColor } : candidate) } : item) })}>{colors.map(color => <option key={color} value={color}>{color}</option>)}</select>
            {field.kind === 'status' && <select className={fieldClass} aria-label={`${field.name} group ${option.id}`} value={option.group ?? 'not_started'} onChange={event => update({ ...current, properties: current.properties.map(item => item.key === field.key ? { ...item, options: item.options.map(candidate => candidate.id === option.id ? { ...candidate, group: event.target.value as StatusGroup } : candidate) } : item) })}>{groups.map(group => <option key={group} value={group}>{group}</option>)}</select>}
            <Button variant="ghost" onClick={() => update({ ...current, properties: current.properties.map(item => item.key === field.key ? { ...item, options: item.options.filter(candidate => candidate.id !== option.id) } : item) })}>{chinese ? '删除选项' : 'Remove option'}</Button>
          </div>)}
          <Button variant="outline" onClick={() => update({ ...current, properties: current.properties.map(item => item.key === field.key ? { ...item, options: [...item.options, { id: `option_${crypto.randomUUID().slice(0, 8)}`, name: chinese ? '新选项' : 'New option', ...(field.kind === 'status' ? { group: 'not_started' as const } : {}) }] } : item) })}>{chinese ? '添加选项' : 'Add option'}</Button>
        </div>}
      </div>)}</div>
      <div className="mt-4 flex gap-2"><select className={fieldClass} aria-label={chinese ? '新属性类型' : 'New property kind'} value={newKind} onChange={event => setNewKind(event.target.value as PropertyKind)}>{kinds.map(kind => <option key={kind}>{kind}</option>)}</select>
      <Button variant="outline" onClick={() => update({ ...current, properties: [...current.properties, { key: `field_${crypto.randomUUID().slice(0, 8)}`, name: chinese ? '新属性' : 'New property', kind: newKind, options: [] }] })}>{chinese ? '添加属性' : 'Add property'}</Button></div>
    </div>
    </fieldset>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>
}
