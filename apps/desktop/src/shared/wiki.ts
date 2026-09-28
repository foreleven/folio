import { Schema } from 'effect'

export const PropertyKind = Schema.Literals(['text', 'number', 'checkbox', 'date', 'datetime', 'url', 'email', 'phone', 'select', 'multi-select', 'status'])
export type PropertyKind = typeof PropertyKind.Type
export const PropertyValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Array(Schema.String), Schema.Null])
export const OptionColor = Schema.Literals(['default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'])
export type OptionColor = typeof OptionColor.Type
export const StatusGroup = Schema.Literals(['not_started', 'in_progress', 'complete'])
export type StatusGroup = typeof StatusGroup.Type
export const PropertyOption = Schema.Struct({
  id: Schema.NonEmptyString, name: Schema.NonEmptyString,
  color: Schema.optionalKey(OptionColor), group: Schema.optionalKey(StatusGroup)
})
export type PropertyOption = typeof PropertyOption.Type
export const PropertyDefinition = Schema.Struct({
  key: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  kind: PropertyKind,
  options: Schema.Array(PropertyOption)
})
export type PropertyDefinition = typeof PropertyDefinition.Type
export const ObjectType = Schema.Struct({
  id: Schema.NonEmptyString, name: Schema.NonEmptyString, icon: Schema.String,
  properties: Schema.Array(PropertyDefinition)
})
export type ObjectType = typeof ObjectType.Type
export const PageMetadata = Schema.Struct({
  id: Schema.NonEmptyString, title: Schema.String, objectType: Schema.NonEmptyString,
  parentId: Schema.NullOr(Schema.String), icon: Schema.String, cover: Schema.NullOr(Schema.String),
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
/** A Project's time-bearing links are projected from canonical Page metadata. */
export const ProjectTimelineEntry = Schema.Struct({
  id: Schema.String, title: Schema.String, objectType: Schema.Literals(['meeting', 'decision', 'event']),
  occurredAt: Schema.String
})
export type ProjectTimelineEntry = typeof ProjectTimelineEntry.Type
export const RawCitationView = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('file'), commit: Schema.String, path: Schema.String,
    fragment: Schema.NullOr(Schema.String), content: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('deletion'), commit: Schema.String, path: Schema.String,
    fragment: Schema.NullOr(Schema.String), priorContent: Schema.String, diff: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('too-large'), commit: Schema.String, path: Schema.String,
    fragment: Schema.NullOr(Schema.String) })
])
export type RawCitationView = typeof RawCitationView.Type
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
    { key: 'status', name: 'Status', kind: 'status', options: [
      { id: 'not_started', name: 'Not started', group: 'not_started' },
      { id: 'in_progress', name: 'In progress', group: 'in_progress' },
      { id: 'done', name: 'Done', group: 'complete' }
    ] }
  ] },
  { id: 'person', name: 'Person', icon: '👤', properties: [
    { key: 'email', name: 'Email', kind: 'email', options: [] },
    { key: 'phone', name: 'Phone', kind: 'phone', options: [] }
  ] },
  { id: 'organization', name: 'Organization', icon: '🏢', properties: [
    { key: 'website', name: 'Website', kind: 'url', options: [] }
  ] },
  { id: 'meeting', name: 'Meeting', icon: '🗓️', properties: [
    { key: 'occurredAt', name: 'Occurred at', kind: 'datetime', options: [] }
  ] },
  { id: 'decision', name: 'Decision', icon: '⚖️', properties: [
    { key: 'occurredAt', name: 'Occurred at', kind: 'datetime', options: [] },
    { key: 'status', name: 'Status', kind: 'status', options: [
      { id: 'proposed', name: 'Proposed', group: 'not_started' },
      { id: 'accepted', name: 'Accepted', group: 'complete' },
      { id: 'superseded', name: 'Superseded', group: 'complete' }
    ] }
  ] },
  { id: 'event', name: 'Event', icon: '📍', properties: [
    { key: 'occurredAt', name: 'Occurred at', kind: 'datetime', options: [] }
  ] }
]

/** A newly authored page has a stable identity before it reaches disk. */
export function newPageMetadata(id: string, objectType = 'page', parentId: string | null = null): PageMetadata {
  const now = new Date().toISOString()
  return { id, title: '', objectType, parentId, icon: '', cover: null, favorite: false, trashed: false,
    createdAt: now, updatedAt: now, properties: {} }
}

/** Validate the authoritative frontmatter against the active ObjectType definition. */
export function validatePageProperties(page: PageMetadata, type: ObjectType): void {
  if (Object.keys(page.properties).some(key => !type.properties.some(field => field.key === key)))
    throw new Error('Page contains an unknown property')
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
      case 'datetime': valid = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value)
        && Number.isFinite(Date.parse(value)); break
      case 'url': valid = typeof value === 'string' && /^https?:\/\//i.test(value) && URL.canParse(value); break
      case 'email': valid = typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); break
      case 'phone': valid = typeof value === 'string' && /^\+?[\d()\s.-]{3,30}$/.test(value); break
      case 'select':
      case 'status': valid = typeof value === 'string' && field.options.some(option => option.id === value); break
      case 'multi-select': valid = Array.isArray(value) && value.every(item => typeof item === 'string' && field.options.some(option => option.id === item)); break
    }
    if (!valid) throw new Error(`Invalid property: ${field.name}`)
  }
}
