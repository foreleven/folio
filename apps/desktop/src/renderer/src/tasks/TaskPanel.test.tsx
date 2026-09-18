// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskPanel } from './TaskPanel'

const mocks = vi.hoisted(() => ({ create: vi.fn(), refresh: vi.fn(), tasks: [] as unknown[], integrations: [] as unknown[] }))
vi.mock('@effect/atom-react', () => ({
  useAtomRefresh: () => mocks.refresh, useAtomSet: () => mocks.create,
  useAtomValue: (atom: unknown) => ({ _tag: 'Success', value: atom === 'integrations' ? mocks.integrations : mocks.tasks })
}))
vi.mock('../rpc/integration-rpc', () => ({ IntegrationRpcClient: { integrations: 'integrations' } }))
vi.mock('../rpc/task-rpc', () => ({ TaskRpcClient: { create: {}, reopen: {}, query: () => ({}) } }))
vi.mock('../preferences', () => ({ useLocale: () => 'en' }))
vi.mock('./TaskSessions', () => ({ TaskSessions: ({ task }: { task: { id: string } }) => <div data-testid="sessions">{task.id}</div> }))
afterEach(() => { cleanup(); vi.resetAllMocks(); mocks.tasks = []; mocks.integrations = [] })

describe('Task creation', () => {
  it('defaults to pi, rejects duplicate submission and reuses identity after a lost reply', async () => {
    let reject!: (error: Error) => void
    mocks.create.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    render(<TaskPanel />)
    fireEvent.change(screen.getByLabelText('Task goal'), { target: { value: '  Summarize notes  ' } })
    const submit = screen.getByRole('button', { name: 'Create task' })
    fireEvent.click(submit)
    fireEvent.submit(submit.closest('form')!)
    expect(mocks.create).toHaveBeenCalledTimes(1)
    const first = mocks.create.mock.calls[0]![0]
    expect(first.payload).toMatchObject({ goal: 'Summarize notes', agent: 'pi' })
    await act(async () => { reject(new Error('response lost')) })
    expect(screen.getByRole('alert').textContent).toContain('retained')
    mocks.create.mockResolvedValueOnce({})
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create task' })) })
    expect(mocks.create.mock.calls[1]![0]).toEqual(first)
    expect((screen.getByLabelText('Task goal') as HTMLTextAreaElement).value).toBe('')
    expect(mocks.refresh).toHaveBeenCalledTimes(2)
  })

  it.each(['pending', 'creating', 'ready'])('opens Sessions before workspace preparation (%s) without resubmitting the Task', async worktreeState => {
    mocks.tasks = [{ id: 'original', goal: 'Persisted intent', state: 'active', worktreeState, configuration: { agent: 'pi', integrationIds: ['notes'] } }]
    render(<TaskPanel />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sessions' })) })
    expect(screen.getByTestId('sessions').textContent).toBe('original')
    expect(mocks.create).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('saves explicit Integration selection and allocates new intent when a failed request selection changes', async () => {
    mocks.integrations = [
      { id: 'notes', name: 'Notes', busy: false, record: { state: 'ready' }, states: { ready: { kind: 'ready' } } },
      { id: 'mail', name: 'Mail', busy: false, record: null, states: {} }
    ]
    mocks.create.mockRejectedValueOnce(new Error('lost reply')).mockResolvedValueOnce({})
    render(<TaskPanel />)
    fireEvent.change(screen.getByLabelText('Task goal'), { target: { value: 'Use selected resources' } })
    expect((screen.getByRole('checkbox', { name: /Mail/ }) as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Notes' }))
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'codex' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create task' })) })
    const previous = mocks.create.mock.calls[0]![0].payload
    expect(previous.agent).toBe('codex')
    expect(previous.integrationIds).toEqual(['notes'])
    fireEvent.click(screen.getByRole('checkbox', { name: 'Notes' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create task' })) })
    expect(mocks.create.mock.calls[1]![0].payload.integrationIds).toEqual([])
    expect(mocks.create.mock.calls[1]![0].payload.id).not.toBe(previous.id)
  })

  it('offers reopen for a released Task and keeps the same identity', async () => {
    mocks.tasks = [{ id: 'completed', goal: 'Inspect again', state: 'completed', worktreeState: 'released', configuration: { agent: 'pi', integrationIds: [] } }]
    mocks.create.mockResolvedValueOnce({})
    render(<TaskPanel />)
    expect(screen.getAllByText((_, element) => element?.textContent?.includes('Completed') ?? false).length).toBeGreaterThan(0)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reopen' })) })
    expect(mocks.create).toHaveBeenCalledWith({ payload: { taskId: 'completed' } })
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
  })
})
