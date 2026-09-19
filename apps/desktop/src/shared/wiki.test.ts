import { describe, expect, it } from 'vitest'
import { newPageMetadata, validatePageProperties, type PropertyKind } from './wiki'

describe('ObjectType property validation', () => {
  it.each([
    ['text', 'hello', 3], ['number', 42, '42'], ['checkbox', false, 'false'],
    ['date', '2026-09-19', '2026-02-30'], ['url', 'https://example.com', 'javascript:alert(1)'],
    ['select', 'Open', 'Unknown'], ['multi-select', ['Open'], ['Unknown']], ['relation', ['page-id'], [3]]
  ])('validates %s values and permits unset properties', (kind, valid, invalid) => {
    const type = { id: 'test', name: 'Test', icon: '', properties: [{ key: 'field', name: 'Field', kind: kind as PropertyKind, options: ['Open', 'Closed'] }] }
    const page = newPageMetadata('test')
    expect(() => validatePageProperties(page, type)).not.toThrow()
    expect(() => validatePageProperties({ ...page, properties: { field: valid } }, type)).not.toThrow()
    expect(() => validatePageProperties({ ...page, properties: { field: invalid as never } }, type)).toThrow('Field')
  })
})
