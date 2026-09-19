import { useState } from 'react'
import { Button } from '@folio/ui/components/ui/button'
import type { ObjectType, PropertyKind } from '../../../shared/wiki'
const kinds: PropertyKind[] = ['text', 'number', 'checkbox', 'date', 'url', 'select', 'multi-select', 'relation']
const fieldClass = 'rounded border bg-background px-2 py-1.5 text-sm'

export function ObjectTypesEditor({ initial, onSave, onClose, chinese }: {
  initial: readonly ObjectType[]; onSave: (types: readonly ObjectType[]) => Promise<void>; onClose: () => void; chinese: boolean
}) {
  const [types, setTypes] = useState(initial)
  const [selected, setSelected] = useState(initial[0]!.id)
  const [name, setName] = useState('')
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
    <p className="text-sm text-muted-foreground">{chinese ? '为不同的知识定义属性。修改类型不会删除已有的属性值。' : 'Define properties for each kind of knowledge. Existing property values are retained when a type changes.'}</p>
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
        <select className={fieldClass} aria-label={`${chinese ? '属性类型' : 'Property kind'} ${index + 1}`} value={field.kind} onChange={event => update({ ...current, properties: current.properties.map(item => item.key === field.key ? { ...item, kind: event.target.value as PropertyKind } : item) })}>
          {kinds.map(kind => <option key={kind}>{kind}</option>)}
        </select>
        {['select', 'multi-select'].includes(field.kind) && <input className={`${fieldClass} min-w-40 flex-1`} aria-label={`${chinese ? '选项' : 'Options'} ${index + 1}`} placeholder={chinese ? '选项，以逗号分隔' : 'Comma-separated options'} value={field.options.join(', ')}
          onChange={event => update({ ...current, properties: current.properties.map(item => item.key === field.key ? { ...item, options: event.target.value.split(',').map(item => item.trim()) } : item) })}
          onBlur={() => update({ ...current, properties: current.properties.map(item => item.key === field.key ? { ...item, options: [...new Set(item.options.filter(Boolean))] } : item) })} />}
        <Button variant="ghost" onClick={() => update({ ...current, properties: current.properties.filter(item => item.key !== field.key) })}>{chinese ? '移除' : 'Remove'}</Button>
      </div>)}</div>
      <Button variant="outline" className="mt-4" onClick={() => update({ ...current, properties: [...current.properties, { key: `field_${crypto.randomUUID().slice(0, 8)}`, name: chinese ? '新属性' : 'New property', kind: 'text', options: [] }] })}>{chinese ? '添加属性' : 'Add property'}</Button>
    </div>
    </fieldset>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>
}
