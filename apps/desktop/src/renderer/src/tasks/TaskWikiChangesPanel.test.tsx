// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GitSyncOperation, WorkspaceChangesView, WorkspaceFileDiff } from '../../../shared/git-change'
import { TaskWikiChangesPanel } from './TaskWikiChangesPanel'

const mocks = vi.hoisted(() => ({ save: vi.fn(), saveRun: vi.fn(), confirmRun: vi.fn(), sync: vi.fn(), reprepare: vi.fn(), startConflict: vi.fn(), resolveConflict: vi.fn(), abortConflict: vi.fn(), refresh: vi.fn(), query: vi.fn((method: string, payload: unknown) => ({ method, payload })),
  context: { files: ['wiki/one.md'], commonBase: 'a'.repeat(40), canonicalDiff: '-main', taskDiff: '+task' },
  detail: { sessions: [] as Array<{ id: string; purpose: string; syncOperationId?: string | null }>, runs: [] as Array<{ id: string; prompt: string; purpose: string; state: string; syncState: string; baselineCommit: string; sessionId?: string }> },
  history: { messages: [] as Array<{ id: string; runId: string | null; data: { role: string; content: unknown } }>, tools: [] as Array<{ id: string; runId: string | null; data: Record<string, unknown> }> },
  view: { head: 'a'.repeat(40), registered: true, files: [
    { path: 'wiki/one.md', status: 'modified', selectable: true }, { path: 'wiki/two.md', status: 'added', selectable: true }
  ], pending: [] } as WorkspaceChangesView,
  operations: [] as GitSyncOperation[], diff: { kind: 'text', text: '+hello <script>unsafe()</script>' } as WorkspaceFileDiff }))
vi.mock('@effect/atom-react', () => ({
  useAtomRefresh: () => mocks.refresh,
  useAtomSet: (atom: string) => atom === 'save' ? mocks.save : atom === 'save-run' ? mocks.saveRun : atom === 'confirm-run' ? mocks.confirmRun : atom === 'sync' ? mocks.sync : atom === 'reprepare' ? mocks.reprepare
    : atom === 'start-conflict' ? mocks.startConflict : atom === 'resolve-conflict' ? mocks.resolveConflict : mocks.abortConflict,
  useAtomValue: (query: { method: string }) => query.method === 'tasks.wikiDiff' ? { _tag: 'Success', value: mocks.diff }
    : query.method === 'tasks.wikiConflictContext' ? { _tag: 'Success', value: mocks.context }
    : query.method === 'tasks.sessionHistory' ? { _tag: 'Success', value: mocks.history }
    : query.method === 'tasks.get' ? { _tag: 'Success', value: mocks.detail }
    : query.method === 'tasks.pendingSynchronizations' ? { _tag: 'Success', value: mocks.operations }
      : { _tag: 'Success', value: mocks.view }
}))
vi.mock('../rpc/task-rpc', () => ({ TaskRpcClient: { query: mocks.query, saveTaskWikiFiles: 'save', saveRunWikiFiles: 'save-run', confirmRunWikiUnchanged: 'confirm-run', synchronizeTaskWiki: 'sync', reprepareTaskWiki: 'reprepare', startConflictResolution: 'start-conflict', resolveTaskWikiConflict: 'resolve-conflict', abortTaskWikiConflict: 'abort-conflict' } }))
vi.mock('../preferences', () => ({ useLocale: () => 'en' }))

afterEach(() => {
  cleanup(); window.sessionStorage.clear(); vi.clearAllMocks(); mocks.save.mockReset(); mocks.saveRun.mockReset(); mocks.confirmRun.mockReset(); mocks.sync.mockReset(); mocks.reprepare.mockReset()
  mocks.startConflict.mockReset(); mocks.resolveConflict.mockReset(); mocks.abortConflict.mockReset()
  mocks.view = { head: 'a'.repeat(40), registered: true, files: [
    { path: 'wiki/one.md', status: 'modified', selectable: true }, { path: 'wiki/two.md', status: 'added', selectable: true }
  ], pending: [] }
  mocks.operations = []; mocks.diff = { kind: 'text', text: '+hello <script>unsafe()</script>' }
  mocks.context = { files: ['wiki/one.md'], commonBase: 'a'.repeat(40), canonicalDiff: '-main', taskDiff: '+task' }
  mocks.detail = { sessions: [], runs: [] }; mocks.history = { messages: [], tools: [] }
})

it('previews and explicitly saves selected Task files, then synchronizes with a new stable ID', async () => {
  render(<TaskWikiChangesPanel vaultId="vault" taskId="task" />)
  expect((screen.getByRole('button', { name: 'Save selected files' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'View diff wiki/one.md' }))
  expect(screen.getByText('+hello <script>unsafe()</script>')).toBeTruthy()
  expect(document.querySelector('script')).toBeNull()
  fireEvent.click(screen.getByLabelText('wiki/one.md'))
  mocks.save.mockResolvedValueOnce({ commit: 'b'.repeat(40), state: 'applied' })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save selected files' })))
  const saveRequest = mocks.save.mock.calls[0]![0]
  expect(saveRequest.payload).toMatchObject({ vaultId: 'vault', input: { taskId: 'task', expectedParent: 'a'.repeat(40), paths: ['wiki/one.md'] } })
  expect(screen.getByText('Task commit: bbbbbbbb')).toBeTruthy()
  mocks.sync.mockResolvedValueOnce({ state: 'aligned' })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sync to main' })))
  expect(mocks.sync.mock.calls[0]![0].payload).toMatchObject({ vaultId: 'vault', input: { taskId: 'task', expectedSourceHead: 'b'.repeat(40) } })
  expect(mocks.sync.mock.calls[0]![0].payload.input.id).toBeTruthy()
})

it('saves selected wiki files with explicit successful Run provenance', async () => {
  mocks.detail = { sessions: [], runs: [{ id: 'run-a', prompt: 'Collect notes', purpose: 'execution', state: 'succeeded', syncState: 'pending', baselineCommit: 'a'.repeat(40) }] }
  render(<TaskWikiChangesPanel vaultId="vault" taskId="task" />)
  fireEvent.click(screen.getByLabelText('Run source run-a'))
  fireEvent.click(screen.getByLabelText('wiki/one.md'))
  mocks.saveRun.mockResolvedValueOnce({ commit: 'b'.repeat(40), state: 'applied' })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save and attribute to selected Runs' })))
  expect(mocks.saveRun).toHaveBeenCalledWith({ payload: { vaultId: 'vault', input: {
    taskId: 'task', runIds: ['run-a'], expectedParent: 'a'.repeat(40), paths: ['wiki/one.md'], id: expect.any(String)
  } } })
  expect(mocks.save).not.toHaveBeenCalled()
})

it('offers a durable no-change receipt for a successful Run', async () => {
  mocks.detail = { sessions: [], runs: [{ id: 'run-empty', prompt: 'Inspect only', purpose: 'execution', state: 'succeeded', syncState: 'pending', baselineCommit: 'a'.repeat(40) }] }
  render(<TaskWikiChangesPanel vaultId="vault" taskId="task" />)
  mocks.confirmRun.mockResolvedValueOnce({ id: 'run-empty', syncState: 'not-required' })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Confirm no wiki changes' })))
  expect(mocks.confirmRun).toHaveBeenCalledWith({ payload: { vaultId: 'vault', input: { taskId: 'task', runId: 'run-empty', expectedHead: 'a'.repeat(40) } } })
})

it('retains a failed save identity and does not advance a stale selection after refresh', async () => {
  const view = render(<TaskWikiChangesPanel vaultId="vault" taskId="task" />)
  fireEvent.click(screen.getByLabelText('wiki/one.md'))
  mocks.save.mockRejectedValueOnce(new Error('lost response'))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save selected files' })))
  const request = mocks.save.mock.calls[0]![0]
  mocks.view = { ...mocks.view, head: 'c'.repeat(40), registered: false }
  view.rerender(<TaskWikiChangesPanel vaultId="vault" taskId="task" />)
  expect(screen.getByRole('alert').textContent).toContain('original operation is retained')
  mocks.save.mockResolvedValueOnce({ commit: 'd'.repeat(40), state: 'applied' })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry save' })))
  expect(mocks.save.mock.calls[1]![0]).toEqual(request)
})

it('retains a failed synchronization identity and retries the same operation', async () => {
  render(<TaskWikiChangesPanel vaultId="vault" taskId="task" />)
  fireEvent.click(screen.getByLabelText('wiki/one.md'))
  mocks.save.mockResolvedValueOnce({ commit: 'b'.repeat(40), state: 'applied' })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save selected files' })))
  const syncButton = screen.getByRole('button', { name: 'Sync to main' })
  mocks.sync.mockRejectedValueOnce(new Error('lost response'))
  await act(async () => fireEvent.click(syncButton))
  expect(screen.getByRole('alert').textContent).toContain('receipt is retained')
  const request = mocks.sync.mock.calls[0]![0]
  mocks.sync.mockResolvedValueOnce({ state: 'aligned' })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sync to main' })))
  expect(mocks.sync.mock.calls[1]![0]).toEqual(request)
})

it('restores a failed save and synchronization intent after the panel is remounted', async () => {
  const first = render(<TaskWikiChangesPanel vaultId="vault" taskId="task" />)
  fireEvent.click(screen.getByLabelText('wiki/one.md'))
  mocks.save.mockRejectedValueOnce(new Error('lost response'))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save selected files' })))
  const saveRequest = mocks.save.mock.calls[0]![0]
  first.unmount()

  render(<TaskWikiChangesPanel vaultId="vault" taskId="task" />)
  expect(screen.getByRole('button', { name: 'Retry save' })).toBeTruthy()
  mocks.save.mockResolvedValueOnce({ commit: 'b'.repeat(40), state: 'applied' })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry save' })))
  expect(mocks.save.mock.calls[1]![0]).toEqual(saveRequest)

  mocks.sync.mockRejectedValueOnce(new Error('lost response'))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sync to main' })))
  const syncRequest = mocks.sync.mock.calls[0]![0]
  cleanup()
  render(<TaskWikiChangesPanel vaultId="vault" taskId="task" />)
  expect(screen.getByRole('button', { name: 'Sync to main' })).toBeTruthy()
  mocks.sync.mockResolvedValueOnce({ state: 'aligned' })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sync to main' })))
  expect(mocks.sync.mock.calls[1]![0]).toEqual(syncRequest)
})

it('surfaces a retained prepared operation and offers reprepare without silently saving files', async () => {
  mocks.operations = [{ id: 'old-sync', taskId: 'task', supersedesId: null, sourceFrontier: 'a'.repeat(40), sourceHead: 'b'.repeat(40),
    sourceChanges: ['change'], sourceCommits: ['b'.repeat(40)], mainBase: 'a'.repeat(40), canonicalCommits: [], conflictIndex: null,
    preparedHead: 'c'.repeat(40), publishedHead: null, alignedHead: null, alignmentCommit: null, state: 'prepared', createdAt: 1 }]
  render(<TaskWikiChangesPanel vaultId="vault" taskId="task" />)
  expect(screen.getByRole('button', { name: 'Reprepare after main changed' })).toBeTruthy()
  mocks.reprepare.mockResolvedValueOnce({ id: 'replacement', state: 'prepared' })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Reprepare after main changed' })))
  expect(mocks.reprepare).toHaveBeenCalledWith({ payload: { vaultId: 'vault', input: { taskId: 'task', supersededId: 'old-sync', id: expect.any(String) } } })
  expect(mocks.save).not.toHaveBeenCalled()
})

it('retries a failed reprepare with the same operation identity', async () => {
  mocks.operations = [{ id: 'old-sync', taskId: 'task', supersedesId: null, sourceFrontier: 'a'.repeat(40), sourceHead: 'b'.repeat(40),
    sourceChanges: ['change'], sourceCommits: ['b'.repeat(40)], mainBase: 'a'.repeat(40), canonicalCommits: [], conflictIndex: null,
    preparedHead: 'c'.repeat(40), publishedHead: null, alignedHead: null, alignmentCommit: null, state: 'prepared', createdAt: 1 }]
  render(<TaskWikiChangesPanel vaultId="vault" taskId="task" />)
  const button = screen.getByRole('button', { name: 'Reprepare after main changed' })
  mocks.reprepare.mockRejectedValueOnce(new Error('lost response'))
  await act(async () => fireEvent.click(button))
  const request = mocks.reprepare.mock.calls[0]![0]
  expect(screen.getByRole('button', { name: 'Reprepare after main changed' })).toBeTruthy()
  mocks.reprepare.mockResolvedValueOnce({ id: 'replacement', state: 'prepared' })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Reprepare after main changed' })))
  expect(mocks.reprepare.mock.calls[1]![0]).toEqual(request)
})

it('reconstructs the same replacement identity after a refresh without renderer storage', async () => {
  mocks.operations = [{ id: 'old-sync', taskId: 'task', supersedesId: null, sourceFrontier: 'a'.repeat(40), sourceHead: 'b'.repeat(40),
    sourceChanges: ['change'], sourceCommits: ['b'.repeat(40)], mainBase: 'a'.repeat(40), canonicalCommits: [], conflictIndex: null,
    preparedHead: 'c'.repeat(40), publishedHead: null, alignedHead: null, alignmentCommit: null, state: 'prepared', createdAt: 1 }]
  const first = render(<TaskWikiChangesPanel vaultId="vault" taskId="task" />)
  mocks.reprepare.mockRejectedValueOnce(new Error('lost response'))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Reprepare after main changed' })))
  const request = mocks.reprepare.mock.calls[0]![0]
  first.unmount()
  window.sessionStorage.clear()
  render(<TaskWikiChangesPanel vaultId="vault" taskId="task" />)
  mocks.reprepare.mockRejectedValueOnce(new Error('lost response'))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Reprepare after main changed' })))
  expect(mocks.reprepare.mock.calls[1]![0]).toEqual(request)
})

it('offers the same explicit reprepare action for a conflict with a staged resolution', async () => {
  mocks.operations = [{ id: 'conflict-sync', taskId: 'task', supersedesId: null, sourceFrontier: 'a'.repeat(40), sourceHead: 'b'.repeat(40),
    sourceChanges: ['change'], sourceCommits: ['b'.repeat(40)], mainBase: 'a'.repeat(40), canonicalCommits: [], conflictIndex: 0,
    preparedHead: null, publishedHead: null, alignedHead: null, alignmentCommit: null, state: 'conflict', createdAt: 1 }]
  render(<TaskWikiChangesPanel vaultId="vault" taskId="task" />)
  expect(screen.getByRole('button', { name: 'Reprepare conflict on current main' })).toBeTruthy()
  mocks.reprepare.mockResolvedValueOnce({ id: 'replacement', state: 'conflict' })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Reprepare conflict on current main' })))
  expect(mocks.reprepare).toHaveBeenCalledWith({ payload: { vaultId: 'vault', input: { taskId: 'task', supersededId: 'conflict-sync', id: expect.any(String) } } })
  expect(mocks.save).not.toHaveBeenCalled()
})

it('offers conflict resolution again when reprepare returns a new conflict operation', async () => {
  mocks.detail = { sessions: [{ id: 'source-session', purpose: 'task' }], runs: [] }
  mocks.operations = [{ id: 'old-conflict', taskId: 'task', supersedesId: null, sourceFrontier: 'a'.repeat(40), sourceHead: 'b'.repeat(40),
    sourceChanges: ['change'], sourceCommits: ['b'.repeat(40)], mainBase: 'a'.repeat(40), canonicalCommits: [], conflictIndex: 0,
    preparedHead: null, publishedHead: null, alignedHead: null, alignmentCommit: null, state: 'conflict', createdAt: 1 }]
  const panel = render(<TaskWikiChangesPanel vaultId="vault" taskId="task" />)
  mocks.reprepare.mockResolvedValueOnce({ id: 'replacement-conflict', state: 'conflict' })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Reprepare conflict on current main' })))

  mocks.operations = [{ ...mocks.operations[0]!, id: 'replacement-conflict', supersedesId: 'old-conflict' }]
  panel.rerender(<TaskWikiChangesPanel vaultId="vault" taskId="task" />)
  expect(screen.getByRole('button', { name: 'Start conflict-resolution Run' })).toBeTruthy()
  mocks.startConflict.mockResolvedValueOnce({ id: 'new-conflict-run' })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start conflict-resolution Run' })))
  expect(mocks.startConflict.mock.calls[0]![0].payload).toMatchObject({ operationId: 'replacement-conflict', sourceSessionId: 'source-session' })
})

it('shows conflict evidence and retries the fixed-Agent resolution Run with stable identities', async () => {
  mocks.detail = { sessions: [{ id: 'source-session', purpose: 'task' }, { id: 'conflict-session', purpose: 'conflict-resolution', syncOperationId: 'conflict-sync' }], runs: [
    { id: 'conflict-run', sessionId: 'conflict-session', prompt: 'resolve', purpose: 'conflict-resolution', state: 'running', syncState: 'not-required', baselineCommit: 'a'.repeat(40) }
  ] }
  mocks.history = { messages: [{ id: 'conflict-message', runId: 'conflict-run', data: { role: 'assistant', content: [{ text: 'Resolved note' }] } }], tools: [] }
  mocks.operations = [{ id: 'conflict-sync', taskId: 'task', supersedesId: null, sourceFrontier: 'a'.repeat(40), sourceHead: 'b'.repeat(40),
    sourceChanges: ['change'], sourceCommits: ['b'.repeat(40)], mainBase: 'a'.repeat(40), canonicalCommits: [], conflictIndex: 0,
    preparedHead: null, publishedHead: null, alignedHead: null, alignmentCommit: null, state: 'conflict', createdAt: 1 }]
  render(<TaskWikiChangesPanel vaultId="vault" taskId="task" />)
  expect(screen.getAllByText('wiki/one.md').length).toBeGreaterThan(1)
  expect(screen.getByText('Resolved note')).toBeTruthy()
  mocks.startConflict.mockRejectedValueOnce(new Error('lost response'))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start conflict-resolution Run' })))
  const request = mocks.startConflict.mock.calls[0]![0]
  expect(request.payload).toMatchObject({ vaultId: 'vault', taskId: 'task', operationId: 'conflict-sync', sourceSessionId: 'source-session' })
  mocks.startConflict.mockResolvedValueOnce({ id: request.payload.runId })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start conflict-resolution Run' })))
  expect(mocks.startConflict.mock.calls[1]![0]).toEqual(request)
  mocks.abortConflict.mockResolvedValueOnce({ state: 'aborted' })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Abort conflict' })))
  expect(mocks.abortConflict).toHaveBeenCalledWith({ payload: { vaultId: 'vault', taskId: 'task', id: 'conflict-sync' } })
})

it('reconstructs the same conflict Run identity after refresh without renderer storage', async () => {
  mocks.detail = { sessions: [{ id: 'source-session', purpose: 'task' }], runs: [] }
  mocks.operations = [{ id: 'conflict-sync', taskId: 'task', supersedesId: null, sourceFrontier: 'a'.repeat(40), sourceHead: 'b'.repeat(40),
    sourceChanges: ['change'], sourceCommits: ['b'.repeat(40)], mainBase: 'a'.repeat(40), canonicalCommits: [], conflictIndex: 0,
    preparedHead: null, publishedHead: null, alignedHead: null, alignmentCommit: null, state: 'conflict', createdAt: 1 }]
  const first = render(<TaskWikiChangesPanel vaultId="vault" taskId="task" />)
  mocks.startConflict.mockRejectedValueOnce(new Error('lost response'))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start conflict-resolution Run' })))
  const request = mocks.startConflict.mock.calls[0]![0]
  first.unmount()
  window.sessionStorage.clear()
  render(<TaskWikiChangesPanel vaultId="vault" taskId="task" />)
  mocks.startConflict.mockRejectedValueOnce(new Error('lost response'))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start conflict-resolution Run' })))
  expect(mocks.startConflict.mock.calls[1]![0]).toEqual(request)
})

it('keeps derived retry identities within the protocol limit for long operation IDs', async () => {
  const operationId = 'x'.repeat(128)
  mocks.detail = { sessions: [{ id: 'source-session', purpose: 'task' }], runs: [] }
  mocks.operations = [{ id: operationId, taskId: 'task', supersedesId: null, sourceFrontier: 'a'.repeat(40), sourceHead: 'b'.repeat(40),
    sourceChanges: ['change'], sourceCommits: ['b'.repeat(40)], mainBase: 'a'.repeat(40), canonicalCommits: [], conflictIndex: 0,
    preparedHead: null, publishedHead: null, alignedHead: null, alignmentCommit: null, state: 'conflict', createdAt: 1 }]
  render(<TaskWikiChangesPanel vaultId="vault" taskId="task" />)
  mocks.startConflict.mockRejectedValueOnce(new Error('lost response'))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start conflict-resolution Run' })))
  const request = mocks.startConflict.mock.calls[0]![0].payload
  expect(request.sessionId.length).toBeLessThanOrEqual(128)
  expect(request.runId.length).toBeLessThanOrEqual(128)
})
