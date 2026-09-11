// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { RoutineRecord, RoutineTrigger, RoutineWakeup } from '../../../shared/routine'
import { RoutinePanel } from './RoutinePanel'
import { RoutineEditor } from './RoutineEditor'
import { HarnessStoreError } from '../../../shared/harness'

const mocks = vi.hoisted(() => ({ save: vi.fn(), create: vi.fn(), start: vi.fn(), refresh: vi.fn(),
  records: [] as RoutineRecord[], history: [] as RoutineTrigger[], wakeups: [] as RoutineWakeup[], wakeupFailure: false }))
vi.mock('@effect/atom-react', () => ({
  useAtomRefresh: () => mocks.refresh,
  useAtomSet: (atom: string) => atom === 'save' ? mocks.save : atom === 'start' ? mocks.start : mocks.create,
  useAtomValue: (atom: string) => atom === 'routines.wakeups' && mocks.wakeupFailure ? { _tag: 'Failure' } : ({ _tag: 'Success', value: atom === 'routines.list' ? mocks.records
    : atom === 'routines.triggers' ? mocks.history : atom === 'routines.wakeups' ? mocks.wakeups : atom === 'catalog' ? { models: [
      { providerId: 'configured', providerName: 'Configured', modelId: 'one', modelName: 'One', source: 'builtin' }
    ] } : atom === 'settings' ? { configuredProviders: ['configured'] } : atom === 'integrations'
      ? [{ id: 'notes', name: 'Notes' }] : [] })
}))
vi.mock('../rpc/task-rpc', () => ({ TaskRpcClient: { saveRoutine: 'save', startRoutineTask: 'start', createRoutineTask: 'create', query: (method: string) => method } }))
vi.mock('../rpc/model-rpc', () => ({ modelCatalogAtom: 'catalog', modelsAtom: 'settings' }))
vi.mock('../rpc/integration-rpc', () => ({ IntegrationRpcClient: { integrations: 'integrations' } }))
vi.mock('../preferences', () => ({ useLocale: () => 'en' }))
const record: RoutineRecord = { id: 'routine', revision: 1, createdAt: 0, updatedAt: 0,
  definition: { name: 'Daily notes', prompt: 'Read notes', configuration: { agent: 'codex', skillIds: [], integrationIds: ['notes'] },
    model: null, enabled: true } }
afterEach(() => { cleanup(); vi.resetAllMocks(); mocks.records = []; mocks.history = []; mocks.wakeups = []; mocks.wakeupFailure = false })

it('shows retained pending times and accepted batch times without dispatching on read or refresh', async () => {
  mocks.records = [{ ...record, definition: { ...record.definition, enabled: false } }]
  mocks.history = [{ id: 'batch', routineId: record.id, expectedRevision: 1, taskId: 'task', snapshot: record, createdAt: 500 }]
  mocks.wakeups = [100, 200, 300].map((triggeredAt, index) => ({ id: `w${index}`, routineId: record.id,
    triggeredAt, receivedAt: triggeredAt + 1, triggerId: index === 2 ? 'batch' : null }))
  render(<RoutinePanel vaultId="vault" />)
  fireEvent.click(screen.getByRole('button', { name: 'Occurrence history' }))
  const pending = screen.getByRole('region', { name: 'Pending occurrences' })
  expect(pending.textContent).toContain('2 occurrences waiting')
  expect(pending.textContent).toContain('paused; these records are retained')
  expect([...pending.querySelectorAll('time')].map(element => element.dateTime)).toEqual([100, 200].map(time => new Date(time).toISOString()))
  const summary = screen.getByText('Combined occurrence times')
  expect(summary.closest('details')?.querySelector('time')?.dateTime).toBe(new Date(300).toISOString())
  await act(async () => fireEvent.click(within(pending).getByRole('button', { name: 'Refresh occurrences' })))
  expect(mocks.refresh).toHaveBeenCalled()
  expect(mocks.start).not.toHaveBeenCalled()
  expect(mocks.create).not.toHaveBeenCalled()
  expect(mocks.save).not.toHaveBeenCalled()
})

it('distinguishes queue loading failure from an empty queue and retains accepted task history', () => {
  mocks.records = [record]
  mocks.wakeupFailure = true
  mocks.history = [{ id: 'batch', routineId: record.id, expectedRevision: 1, taskId: 'task', snapshot: record, createdAt: 0 }]
  const view = render(<RoutinePanel vaultId="vault" />)
  fireEvent.click(screen.getByRole('button', { name: 'Occurrence history' }))
  expect(screen.getByRole('status').textContent).toContain('Could not load pending occurrences')
  expect(screen.queryByText('No pending occurrences.')).toBeNull()
  expect(screen.getByRole('button', { name: 'Run this task' })).toBeTruthy()
  mocks.wakeupFailure = false
  view.rerender(<RoutinePanel vaultId="vault" />)
  expect(screen.getByText('No pending occurrences.')).toBeTruthy()
})

it('explains why a paused Routine cannot be enabled while its Task has synchronization conflicts', async () => {
  mocks.records = [{ ...record, definition: { ...record.definition, enabled: false } }]
  mocks.save.mockRejectedValueOnce(new HarnessStoreError({ reason: 'routine-conflict', message: 'Conflict' }))
  render(<RoutinePanel vaultId="vault" />)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Enable' })))
  expect(screen.getByRole('alert').textContent).toContain('Resolve them in the original Task')
  expect(mocks.refresh).toHaveBeenCalled()
  expect(mocks.start).not.toHaveBeenCalled()
  expect(mocks.create).not.toHaveBeenCalled()
})

it('retains the draft after an enable conflict and allows saving it while paused', async () => {
  mocks.save.mockRejectedValueOnce(new HarnessStoreError({ reason: 'routine-conflict', message: 'Conflict' }))
  const saved = vi.fn()
  render(<RoutineEditor vaultId="vault" initial={{ id: record.id, record }} onSaved={saved} onCancel={() => {}} />)
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Retained draft' } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save Routine' })))
  expect(screen.getByRole('alert').textContent).toContain('uncheck Enable Routine')
  expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('Retained draft')
  fireEvent.click(screen.getByLabelText('Enable Routine'))
  mocks.save.mockResolvedValueOnce({})
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save Routine' })))
  expect(mocks.save.mock.calls[1]![0].payload.input.definition).toMatchObject({ prompt: 'Retained draft', enabled: false })
  expect(saved).toHaveBeenCalledOnce()
})

it('requires an explicit pi model, guards duplicate save and retains the exact request after a lost reply', async () => {
  let reject!: (error: Error) => void
  mocks.save.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
  const saved = vi.fn()
  render(<RoutineEditor vaultId="vault" initial={{ id: 'new' }} onSaved={saved} onCancel={() => {}} />)
  fireEvent.change(screen.getByLabelText('Routine name'), { target: { value: '  Daily notes  ' } })
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: ' Read notes ' } })
  expect((screen.getByRole('button', { name: 'Save Routine' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: JSON.stringify(['configured', 'one']) } })
  fireEvent.change(screen.getByLabelText('Thinking level'), { target: { value: 'high' } })
  fireEvent.click(screen.getByLabelText('Notes'))
  const button = screen.getByRole('button', { name: 'Save Routine' })
  fireEvent.click(button)
  fireEvent.submit(button.closest('form')!)
  expect(mocks.save).toHaveBeenCalledTimes(1)
  const input = mocks.save.mock.calls[0]![0]
  expect(input.payload).toMatchObject({ vaultId: 'vault', input: { id: 'new', expectedRevision: null,
    definition: { name: 'Daily notes', prompt: 'Read notes', configuration: { agent: 'pi', integrationIds: ['notes'] },
      model: { providerId: 'configured', modelId: 'one', thinkingLevel: 'high' } } } })
  await act(async () => reject(new Error('lost reply')))
  expect(screen.getByRole('alert').textContent).toContain('draft is retained')
  mocks.save.mockResolvedValueOnce({})
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save Routine' })))
  expect(mocks.save.mock.calls[1]![0]).toEqual(input)
  expect(saved).toHaveBeenCalledOnce()
  expect(mocks.create).not.toHaveBeenCalled()
})

it('keeps an editor on its original version when the background list refreshes', async () => {
  mocks.records = [record]
  const view = render(<RoutinePanel vaultId="vault" />)
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Local draft' } })
  mocks.records = [{ ...record, revision: 2, definition: { ...record.definition, prompt: 'Other window' } }]
  view.rerender(<RoutinePanel vaultId="vault" />)
  expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('Local draft')
  mocks.save.mockRejectedValueOnce(new Error('stale version'))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save Routine' })))
  expect(mocks.save.mock.calls[0]![0].payload.input).toMatchObject({ expectedRevision: 1, definition: { prompt: 'Local draft' } })
  expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('Local draft')
})

it('retries an uncertain occurrence unchanged after the Routine has been edited and paused', async () => {
  mocks.records = [record]
  mocks.create.mockRejectedValueOnce(new Error('lost reply')).mockResolvedValueOnce({})
  const view = render(<RoutinePanel vaultId="vault" />)
  expect(mocks.create).not.toHaveBeenCalled()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create task' })))
  const first = mocks.create.mock.calls[0]![0]
  mocks.records = [{ ...record, revision: 2, definition: { ...record.definition, enabled: false, prompt: 'New definition' } }]
  view.rerender(<RoutinePanel vaultId="vault" />)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry task creation' })))
  expect(mocks.create.mock.calls[1]![0]).toEqual(first)
  expect(screen.getByRole('status').textContent).toContain('No prompt has been sent')
  expect((screen.getByRole('button', { name: 'Create task' }) as HTMLButtonElement).disabled).toBe(true)
})

it('restores an accepted historical occurrence even while its Routine is paused', async () => {
  mocks.records = [{ ...record, revision: 2, definition: { ...record.definition, enabled: false } }]
  mocks.history = [{ id: 'accepted', routineId: record.id, expectedRevision: 1, taskId: 'task', snapshot: record, createdAt: 0 }]
  mocks.create.mockResolvedValueOnce({})
  render(<RoutinePanel vaultId="vault" />)
  fireEvent.click(screen.getByRole('button', { name: 'Occurrence history' }))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Prepare / retry this task' })))
  expect(mocks.create).toHaveBeenCalledWith({ payload: { vaultId: 'vault', input: { id: 'accepted', routineId: record.id, expectedRevision: 1 } } })
})

it('pauses only future occurrences without creating or dispatching a Task', async () => {
  mocks.records = [record]
  mocks.save.mockResolvedValueOnce({})
  render(<RoutinePanel vaultId="vault" />)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Pause' })))
  expect(mocks.save).toHaveBeenCalledWith({ payload: { vaultId: 'vault', input: { id: record.id,
    expectedRevision: 1, definition: { ...record.definition, enabled: false } } } })
  expect(mocks.create).not.toHaveBeenCalled()
})

it('keeps unavailable saved model and Integration references while editing an offline definition', async () => {
  const offline: RoutineRecord = { ...record, definition: { ...record.definition,
    configuration: { agent: 'pi', skillIds: [], integrationIds: ['uninstalled'] },
    model: { providerId: 'unavailable', modelId: 'saved', thinkingLevel: 'high' } } }
  mocks.save.mockResolvedValueOnce({})
  render(<RoutineEditor vaultId="vault" initial={{ id: record.id, record: offline }} onSaved={() => {}} onCancel={() => {}} />)
  expect(screen.getByRole('option', { name: /currently unavailable/ })).toBeTruthy()
  expect((screen.getByLabelText('uninstalled') as HTMLInputElement).checked).toBe(true)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save Routine' })))
  expect(mocks.save.mock.calls[0]![0].payload.input.definition).toEqual(offline.definition)
})


it('starts on explicit action and preserves execution intent after an uncertain response', async () => {
  mocks.records = [record]
  mocks.start.mockRejectedValueOnce(new Error('lost reply')).mockResolvedValueOnce({ run: { state: 'preparing' } })
  render(<RoutinePanel vaultId="vault" />)
  expect(mocks.start).not.toHaveBeenCalled()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Run once' })))
  const first = mocks.start.mock.calls[0]![0]
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry execution' })))
  expect(mocks.start.mock.calls[1]![0]).toEqual(first)
  expect(mocks.create).not.toHaveBeenCalled()
  expect(screen.getByRole('status').textContent).toContain('This run is registered')
})

it('queries a previously executed occurrence without presenting it as a fresh execution', async () => {
  mocks.records = [{ ...record, definition: { ...record.definition, enabled: false } }]
  mocks.history = [{ id: 'accepted', routineId: record.id, expectedRevision: 1, taskId: 'task', snapshot: record, createdAt: 0 }]
  mocks.start.mockResolvedValueOnce({ run: { state: 'interrupted' } })
  render(<RoutinePanel vaultId="vault" />)
  fireEvent.click(screen.getByRole('button', { name: 'Occurrence history' }))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Run this task' })))
  expect(mocks.start).toHaveBeenCalledWith({ payload: { vaultId: 'vault', input: { id: 'accepted', routineId: record.id, expectedRevision: 1 } } })
  expect(screen.getByRole('status').textContent).toContain('No prompt was resent')
})
