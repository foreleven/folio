import type { PageSummary } from '../../../shared/wiki'

/** Trash is inherited by descendants; restoring the parent restores the entire visible tree. */
export function inTrash(page: PageSummary, pages: readonly PageSummary[]): boolean {
  const seen = new Set<string>()
  let current: PageSummary | undefined = page
  while (current && !seen.has(current.id)) {
    if (current.trashed) return true
    seen.add(current.id)
    current = pages.find(candidate => candidate.id === current!.parentId)
  }
  return false
}

/** Orphaned/cyclic imported pages stay reachable even while their metadata is being repaired. */
export function pageTree(pages: readonly PageSummary[]): { page: PageSummary; depth: number }[] {
  const result: { page: PageSummary; depth: number }[] = []
  const seen = new Set<string>()
  const visit = (page: PageSummary, depth: number) => {
    if (seen.has(page.id)) return
    seen.add(page.id); result.push({ page, depth })
    for (const child of pages.filter(child => child.parentId === page.id)) visit(child, depth + 1)
  }
  for (const page of pages.filter(page => !page.parentId || !pages.some(parent => parent.id === page.parentId))) visit(page, 0)
  for (const page of pages) visit(page, 0)
  return result
}
