// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { WorkspaceChangesView, WorkspaceFileDiff } from '../../../shared/git-change'
import { WorkspaceChangesPanel } from './WorkspaceChangesPanel'

const mocks = vi.hoisted(() => ({ save: vi.fn(), refresh: vi.fn(), query: vi.fn((method: string, payload: unknown) => ({ method, payload })),
  view: { head: 'a'.repeat(40), registered: true, files: [
    { path: 'wiki/one.md', status: 'modified', selectable: true }, { path: 'wiki/two.md', status: 'added', selectable: true }
  ], pending: [] } as WorkspaceChangesView,
  diff: { kind: 'text', text: '+hello <script>example</script>' } as WorkspaceFileDiff,
  failedQuery: false }))
vi.mock('@effect/atom-react', () => ({
  useAtomRefresh: () => mocks.refresh,
  useAtomSet: () => mocks.save,
  useAtomValue: (query: { method: string }) => query.method === 'workspace.diff'
    ? { _tag: 'Success', value: mocks.diff }
    : mocks.failedQuery ? { _tag: 'Failure' } : { _tag: 'Success', value: mocks.view }
}))
vi.mock('../rpc/task-rpc', () => ({ TaskRpcClient: { query: mocks.query, saveWorkspaceFiles: 'save' } }))
vi.mock('../preferences', () => ({ useLocale: () => 'en' }))
afterEach(() => {
  cleanup(); vi.clearAllMocks(); mocks.save.mockReset()
  mocks.view = { head: 'a'.repeat(40), registered: true, files: [
    { path: 'wiki/one.md', status: 'modified', selectable: true }, { path: 'wiki/two.md', status: 'added', selectable: true }
  ], pending: [] }
  mocks.diff = { kind: 'text', text: '+hello <script>example</script>' }; mocks.failedQuery = false
})

it('requires explicit selection, previews without saving, and submits only the selected files', async () => {
  const view = render(<WorkspaceChangesPanel vaultId="vault" />)
  expect((screen.getByRole('button', { name: 'Save selected files' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'View diff wiki/one.md' }))
  expect(screen.getByText('+hello <script>example</script>')).toBeTruthy()
  expect(view.container.querySelector('script')).toBeNull()
  expect(mocks.save).not.toHaveBeenCalled()
  fireEvent.click(screen.getByLabelText('wiki/one.md'))
  mocks.save.mockResolvedValueOnce({ commit: 'b'.repeat(40), state: 'applied' })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save selected files' })))
  const request = mocks.save.mock.calls[0]![0].payload
  expect(request).toMatchObject({ vaultId: 'vault', input: { expectedParent: 'a'.repeat(40), paths: ['wiki/one.md'] } })
  expect(request.input.id).toBeTruthy()
  expect(screen.getByText('Saved commit: bbbbbbbb')).toBeTruthy()
  expect(mocks.query).toHaveBeenCalledWith('workspace.diff', { vaultId: 'vault', input: {
    expectedParent: 'a'.repeat(40), path: 'wiki/one.md', saveId: request.input.id
  } })
})

it('retains the exact request after failure even when refresh shows a changed baseline', async () => {
  const view = render(<WorkspaceChangesPanel vaultId="vault" />)
  fireEvent.click(screen.getByLabelText('wiki/one.md'))
  mocks.save.mockRejectedValueOnce(new Error('lost reply'))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save selected files' })))
  const request = mocks.save.mock.calls[0]![0]
  mocks.view = { ...mocks.view, head: 'b'.repeat(40), registered: false, pending: [{ ...request.payload.input, state: 'applying' }] }
  view.rerender(<WorkspaceChangesPanel vaultId="vault" />)
  expect(screen.getByRole('alert').textContent).toContain('original request is retained')
  expect((screen.getByLabelText('wiki/two.md') as HTMLInputElement).disabled).toBe(true)
  mocks.save.mockResolvedValueOnce({ commit: 'b'.repeat(40), state: 'applied' })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry save' })))
  expect(mocks.save.mock.calls[1]![0]).toEqual(request)
})

it('does not silently advance an unsubmitted selection to a newly refreshed baseline', () => {
  const view = render(<WorkspaceChangesPanel vaultId="vault" />)
  fireEvent.click(screen.getByLabelText('wiki/one.md'))
  mocks.view = { ...mocks.view, head: 'b'.repeat(40) }
  view.rerender(<WorkspaceChangesPanel vaultId="vault" />)
  expect((screen.getByRole('button', { name: 'Save selected files' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText('Files or baseline changed. Clear the selection and choose again.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
  fireEvent.click(screen.getByLabelText('wiki/two.md'))
  expect((screen.getByRole('button', { name: 'Save selected files' }) as HTMLButtonElement).disabled).toBe(false)
  expect(mocks.save).not.toHaveBeenCalled()
})

it('discovers a retained save, previews its snapshot and retries its original identity after reload', async () => {
  const input = { id: 'retained', expectedParent: 'c'.repeat(40), paths: ['wiki/one.md'] as [string] }
  mocks.view = { ...mocks.view, files: [], pending: [{ ...input, state: 'prepared' }] }
  render(<WorkspaceChangesPanel vaultId="vault" />)
  expect(mocks.save).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'wiki/one.md' }))
  expect(mocks.query).toHaveBeenCalledWith('workspace.diff', { vaultId: 'vault', input: {
    saveId: 'retained', expectedParent: 'c'.repeat(40), path: 'wiki/one.md'
  } })
  mocks.save.mockResolvedValueOnce({ commit: 'd'.repeat(40), state: 'applied' })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry this save' })))
  expect(mocks.save).toHaveBeenCalledWith({ payload: { vaultId: 'vault', input } })
})

it('blocks overlapping submission and preserves input until the pending save settles', async () => {
  let finish!: (value: { commit: string }) => void
  mocks.save.mockImplementation(() => new Promise(done => { finish = done }))
  render(<WorkspaceChangesPanel vaultId="vault" />)
  fireEvent.click(screen.getByLabelText('wiki/two.md'))
  const button = screen.getByRole('button', { name: 'Save selected files' })
  fireEvent.click(button); fireEvent.click(button)
  expect(mocks.save).toHaveBeenCalledOnce()
  expect((screen.getByLabelText('wiki/one.md') as HTMLInputElement).disabled).toBe(true)
  await act(async () => finish({ commit: 'b'.repeat(40) }))
  expect(mocks.refresh).toHaveBeenCalled()
})

it('distinguishes query failure from an empty workspace and shows bounded preview fallbacks', () => {
  mocks.failedQuery = true
  const view = render(<WorkspaceChangesPanel vaultId="vault" />)
  expect(screen.getByText('Could not read changes. Refresh to retry.')).toBeTruthy()
  expect(screen.queryByText('No file changes to save.')).toBeNull()
  mocks.failedQuery = false
  mocks.diff = { kind: 'too-large', text: '' }
  view.rerender(<WorkspaceChangesPanel vaultId="vault" />)
  fireEvent.click(screen.getByRole('button', { name: 'View diff wiki/one.md' }))
  expect(screen.getByText('This file is too large for an inline preview.')).toBeTruthy()
  mocks.diff = { kind: 'binary', text: '' }
  view.rerender(<WorkspaceChangesPanel vaultId="vault" />)
  expect(screen.getByText('Binary file changed.')).toBeTruthy()
  expect(mocks.save).not.toHaveBeenCalled()
})
