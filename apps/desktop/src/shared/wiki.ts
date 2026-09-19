import { Schema } from 'effect'

export const PropertyKind = Schema.Literals(['text', 'number', 'checkbox', 'date', 'url', 'select', 'multi-select', 'relation'])
export type PropertyKind = typeof PropertyKind.Type
export const PropertyValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Array(Schema.String), Schema.Null])
export const PropertyDefinition = Schema.Struct({
  key: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  kind: PropertyKind,
  options: Schema.Array(Schema.String)
})
export type PropertyDefinition = typeof PropertyDefinition.Type
export const ObjectType = Schema.Struct({
  id: Schema.NonEmptyString, name: Schema.NonEmptyString, icon: Schema.String,
  properties: Schema.Array(PropertyDefinition)
})
export type ObjectType = typeof ObjectType.Type
export const PageMetadata = Schema.Struct({
  id: Schema.NonEmptyString, title: Schema.String, objectType: Schema.NonEmptyString,
  parentId: Schema.NullOr(Schema.String), icon: Schema.String, cover: Schema.String,
  favorite: Schema.Boolean, trashed: Schema.Boolean,
  createdAt: Schema.String, updatedAt: Schema.String,
  properties: Schema.Record(Schema.String, PropertyValue)
})
export type PageMetadata = typeof PageMetadata.Type
export const PageSummary = Schema.Struct({ ...PageMetadata.fields, path: Schema.String, version: Schema.String })
export type PageSummary = typeof PageSummary.Type
export const PageDocument = Schema.Struct({ ...PageSummary.fields, body: Schema.String })
export type PageDocument = typeof PageDocument.Type
export const WikiSnapshot = Schema.Struct({
  pages: Schema.Array(PageSummary), objectTypes: Schema.Array(ObjectType), typesVersion: Schema.String,
  issues: Schema.Array(Schema.Struct({ path: Schema.String, message: Schema.String }))
})
export type WikiSnapshot = typeof WikiSnapshot.Type
export const SavePage = Schema.Struct({
  metadata: PageMetadata, body: Schema.String, expectedVersion: Schema.NullOr(Schema.String)
})
export type SavePage = typeof SavePage.Type
export const SaveObjectTypes = Schema.Struct({
  objectTypes: Schema.Array(ObjectType), expectedVersion: Schema.String
})
export type SaveObjectTypes = typeof SaveObjectTypes.Type

export const defaultObjectTypes: readonly ObjectType[] = [
  { id: 'page', name: 'Page', icon: '📄', properties: [] },
  { id: 'note', name: 'Note', icon: '📝', properties: [{ key: 'tags', name: 'Tags', kind: 'multi-select', options: [] }] },
  { id: 'project', name: 'Project', icon: '📁', properties: [
    { key: 'status', name: 'Status', kind: 'select', options: ['Not started', 'In progress', 'Done'] },
    { key: 'due', name: 'Due date', kind: 'date', options: [] }
  ] },
  { id: 'person', name: 'Person', icon: '👤', properties: [
    { key: 'email', name: 'Email', kind: 'text', options: [] },
    { key: 'company', name: 'Company', kind: 'text', options: [] }
  ] },
  { id: 'meeting', name: 'Meeting', icon: '🗓️', properties: [
    { key: 'date', name: 'Date', kind: 'date', options: [] },
    { key: 'attendees', name: 'Attendees', kind: 'relation', options: [] }
  ] }
]

/** A newly authored page has a stable identity before it reaches disk. */
export function newPageMetadata(id: string, objectType = 'page', parentId: string | null = null): PageMetadata {
  const now = new Date().toISOString()
  return { id, title: '', objectType, parentId, icon: '', cover: '', favorite: false, trashed: false,
    createdAt: now, updatedAt: now, properties: {} }
}

/** Validate declared fields without dropping values belonging to a previous ObjectType. */
export function validatePageProperties(page: PageMetadata, type: ObjectType): void {
  for (const field of type.properties) {
    const value = page.properties[field.key]
    if (value === undefined || value === null || value === '') continue
    let valid: boolean
    switch (field.kind) {
      case 'text': valid = typeof value === 'string'; break
      case 'number': valid = typeof value === 'number' && Number.isFinite(value); break
      case 'checkbox': valid = typeof value === 'boolean'; break
      case 'date': valid = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value; break
      case 'url': valid = typeof value === 'string' && /^https?:\/\//i.test(value) && URL.canParse(value); break
      case 'select': valid = typeof value === 'string' && field.options.includes(value); break
      case 'multi-select': valid = Array.isArray(value) && value.every(item => typeof item === 'string' && (!field.options.length || field.options.includes(item))); break
      case 'relation': valid = Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0); break
    }
    if (!valid) throw new Error(`Invalid property: ${field.name}`)
  }
}
