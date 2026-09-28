import { describe, expect, it } from 'vitest'
import { newPageMetadata, validatePageProperties, type PropertyKind } from './wiki'

describe('ObjectType property validation', () => {
  it.each([
    ['text', 'hello', 3], ['number', 42, '42'], ['checkbox', false, 'false'],
    ['date', '2026-09-19', '2026-02-30'], ['datetime', '2026-09-19T12:00:00+08:00', '2026-09-19T12:00:00'],
    ['url', 'https://example.com', 'javascript:alert(1)'], ['email', 'x@example.com', 'invalid'],
    ['phone', '+86 138 0013 8000', 'not a phone'],
    ['select', 'open', 'Unknown'], ['multi-select', ['open'], ['Unknown']], ['status', 'open', 'Unknown']
  ])('validates %s values and permits unset properties', (kind, valid, invalid) => {
    const type = { id: 'test', name: 'Test', icon: '', properties: [{ key: 'field', name: 'Field', kind: kind as PropertyKind, options: [{ id: 'open', name: 'Open' }, { id: 'closed', name: 'Closed' }] }] }
    const page = newPageMetadata('test')
    expect(() => validatePageProperties(page, type)).not.toThrow()
    expect(() => validatePageProperties({ ...page, properties: { field: valid } }, type)).not.toThrow()
    expect(() => validatePageProperties({ ...page, properties: { field: invalid as never } }, type)).toThrow('Field')
  })
})
