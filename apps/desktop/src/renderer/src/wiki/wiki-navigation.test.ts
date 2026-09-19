import { expect, it } from 'vitest'
import { newPageMetadata, type PageSummary } from '../../../shared/wiki'
import { inTrash, pageTree } from './wiki-navigation'
const page = (id: string, parentId: string | null = null, trashed = false): PageSummary => ({
  ...newPageMetadata(id, 'page', parentId), path: `${id}.md`, version: '1', trashed
})
it('keeps imported orphan and cyclic Pages reachable without repeating nodes', () => {
  const pages = [page('a', 'b'), page('b', 'a'), page('orphan', 'missing'), page('root'), page('child', 'root')]
  const tree = pageTree(pages)
  expect(new Set(tree.map(item => item.page.id)).size).toBe(pages.length)
  expect(tree).toHaveLength(pages.length)
  expect(tree.find(item => item.page.id === 'child')?.depth).toBe(1)
})
it('inherits trash through ancestors and restores descendants when the parent is restored', () => {
  const parent = page('parent', null, true), child = page('child', 'parent')
  expect(inTrash(child, [parent, child])).toBe(true)
  expect(inTrash(child, [{ ...parent, trashed: false }, child])).toBe(false)
  expect(inTrash(page('cycle', 'cycle'), [page('cycle', 'cycle')])).toBe(false)
})
