// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskRecord } from '../../../shared/harness'
import { TaskSessions } from './TaskSessions'

const mocks = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn(), refresh: vi.fn(),
  sessions: [] as unknown[], routine: null as unknown, catalog: 'catalog', settings: 'settings', query: 'query', openAtom: 'open' }))
vi.mock('@effect/atom-react', () => ({
  useAtomRefresh: () => mocks.refresh,
  useAtomSet: (atom: string) => atom === mocks.openAtom ? mocks.open : mocks.close,
  useAtomValue: (atom: string) => ({ _tag: 'Success', value: atom === mocks.catalog ? { models: [
    { providerId: 'configured', providerName: 'Configured', modelId: 'one', modelName: 'One', source: 'builtin' },
    { providerId: 'missing', providerName: 'Missing', modelId: 'two', modelName: 'Two', source: 'builtin' }
  ] } : atom === mocks.settings ? { configuredProviders: ['configured'] } : { sessions: mocks.sessions, routine: mocks.routine } })
}))
vi.mock('../rpc/model-rpc', () => ({ modelCatalogAtom: mocks.catalog, modelsAtom: mocks.settings }))
vi.mock('../rpc/task-rpc', () => ({ TaskRpcClient: { openSession: mocks.openAtom, closeSession: 'close', query: () => mocks.query } }))
vi.mock('./TaskConversation', () => ({ TaskConversation: () => null }))
vi.mock('../preferences', () => ({ useLocale: () => 'en' }))
const task: TaskRecord = { id: 'task', goal: 'Notes', branch: 'task', worktree: '/task', state: 'active',
  worktreeState: 'ready', worktreeBase: 'base', createdAt: 0, configuration: { agent: 'pi', skillIds: [], integrationIds: [] } }
afterEach(() => { cleanup(); vi.resetAllMocks(); mocks.sessions = []; mocks.routine = null })

describe('Task Session selection', () => {
  it('defaults to the Routine model snapshot and preserves its thinking level without starting on render', async () => {
    mocks.routine = { snapshot: { definition: { name: 'Routine notes',
      model: { providerId: 'configured', modelId: 'one', thinkingLevel: 'high' } } } }
    mocks.open.mockResolvedValueOnce({})
    render(<TaskSessions vaultId="vault" task={task} />)
    expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe(JSON.stringify(['configured', 'one']))
    expect(mocks.open).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'New session' })))
    expect(mocks.open.mock.calls[0]![0].payload.model).toEqual({ providerId: 'configured', modelId: 'one', thinkingLevel: 'high' })
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: '' } })
    expect((screen.getByRole('button', { name: 'New session' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps an unavailable Routine model visible and requires an explicit replacement', async () => {
    mocks.routine = { snapshot: { definition: { name: 'Routine notes',
      model: { providerId: 'missing', modelId: 'two', thinkingLevel: 'high' } } } }
    mocks.open.mockResolvedValueOnce({})
    render(<TaskSessions vaultId="vault" task={task} />)
    expect(screen.getByRole('option', { name: /currently unavailable/ })).toBeTruthy()
    expect((screen.getByRole('button', { name: 'New session' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: JSON.stringify(['configured', 'one']) } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'New session' })))
    expect(mocks.open.mock.calls[0]![0].payload.model).toEqual({ providerId: 'configured', modelId: 'one', thinkingLevel: 'off' })
  })

  it('requires explicit configured-model selection and preserves the request after a lost response', async () => {
    render(<TaskSessions vaultId="vault" task={task} />)
    expect(mocks.open).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: 'New session' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('option', { name: 'Missing / Two' })).toBeNull()
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: JSON.stringify(['configured', 'one']) } })
    mocks.open.mockRejectedValueOnce(new Error('lost response'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'New session' })) })
    const request = mocks.open.mock.calls[0]![0]
    expect(request.payload.model).toEqual({ providerId: 'configured', modelId: 'one', thinkingLevel: 'off' })
    mocks.open.mockResolvedValueOnce({})
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'New session' })) })
    expect(mocks.open.mock.calls[1]![0]).toEqual(request)
    expect(screen.getByRole('status').textContent).toContain('No prompt has been sent')
  })

  it('restores a saved Session without replacing its model with the current UI choice', async () => {
    mocks.sessions = [{ id: 'saved', agent: 'pi', modelProfile: { provider: { providerId: 'old' }, modelId: 'old-model' } }]
    mocks.open.mockResolvedValueOnce({})
    render(<TaskSessions vaultId="vault" task={task} />)
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: JSON.stringify(['configured', 'one']) } })
    expect(mocks.open).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect / retry' })) })
    expect(mocks.open).toHaveBeenCalledWith({ payload: { vaultId: 'vault', taskId: 'task', sessionId: 'saved', agent: 'pi' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close connection' })) })
    expect(mocks.close).toHaveBeenCalledWith({ payload: { vaultId: 'vault', taskId: 'task', sessionId: 'saved' } })
  })
})
