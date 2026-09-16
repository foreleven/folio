// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessStoreError } from '../../../shared/harness'
import { TaskConversation } from './TaskConversation'

const mocks = vi.hoisted(() => ({ start: vi.fn(), inspect: vi.fn(), cancel: vi.fn(), refresh: vi.fn(), runs: [] as unknown[], messages: [] as unknown[] }))
vi.mock('@effect/atom-react', () => ({
  useAtomRefresh: () => mocks.refresh,
  useAtomSet: (atom: string) => atom === 'start' ? mocks.start : atom === 'inspect' ? mocks.inspect : mocks.cancel,
  useAtomValue: (atom: string) => ({ _tag: 'Success', value: atom === 'tasks.get' ? { runs: mocks.runs } : { messages: mocks.messages, tools: [] } })
}))
vi.mock('../rpc/task-rpc', () => ({ TaskRpcClient: { startRun: 'start', inspectRun: 'inspect', cancelRun: 'cancel', query: (method: string) => method } }))
vi.mock('../preferences', () => ({ useLocale: () => 'en' }))
afterEach(() => { cleanup(); vi.resetAllMocks(); mocks.runs = []; mocks.messages = [] })
const view = () => render(<TaskConversation taskId="task" sessionId="session" />)

describe('Task conversation', () => {
  it('explains Routine contention and retains the prompt for an explicit retry', async () => {
    mocks.start.mockRejectedValueOnce(new HarnessStoreError({ reason: 'routine-busy', message: 'Busy' }))
    view()
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Continue notes' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })))
    expect(screen.getByRole('alert').textContent).toContain('Another Task from this Routine')
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('Continue notes')
    const first = mocks.start.mock.calls[0]![0]
    mocks.start.mockResolvedValueOnce({})
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })))
    expect(mocks.start.mock.calls[1]![0]).toEqual(first)
  })

  it('does not send on render and reuses the exact request after a lost reply', async () => {
    mocks.start.mockRejectedValueOnce(new Error('lost response'))
    view()
    expect(mocks.start).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: '  Inspect notes  ' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })) })
    const input = mocks.start.mock.calls[0]![0]
    expect(input.payload).toMatchObject({ prompt: 'Inspect notes', purpose: 'execution', resumesRunId: null })
    expect(input.payload).not.toHaveProperty('baselineCommit')
    mocks.start.mockResolvedValueOnce({})
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })) })
    expect(mocks.start.mock.calls[1]![0]).toEqual(input)
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('')
  })

  it('keeps a Task reserved across Sessions and sends an explicit stop request', async () => {
    mocks.runs = [{ id: 'active', sessionId: 'other-session', state: 'running', endedAt: null }]
    mocks.cancel.mockResolvedValueOnce({})
    view()
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Next instruction' } })
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop run' })) })
    expect(mocks.cancel).toHaveBeenCalledWith({ payload: { taskId: 'task', runId: 'active' } })
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('inspects an abandoned Run without reconnecting or sending its original Prompt', async () => {
    mocks.runs = [{ id: 'old', sessionId: 'session', state: 'running', prompt: 'Original instruction', endedAt: null }]
    mocks.inspect.mockImplementationOnce(async () => {
      mocks.runs = [{ id: 'old', sessionId: 'session', state: 'interrupted', prompt: 'Original instruction', endedAt: 1 }]
      return {}
    })
    view()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Inspect run' })) })
    expect(mocks.inspect).toHaveBeenCalledWith({ payload: { taskId: 'task', runId: 'old' } })
    expect(mocks.start).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Continue from this run' })).toBeTruthy()
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('')
  })

  it('requires a new recovery instruction and renders tool/model text without interpreting HTML', async () => {
    mocks.runs = [{ id: 'old', sessionId: 'session', state: 'interrupted', prompt: 'Original instruction', endedAt: 1 }]
    mocks.messages = [{ id: 'reply', kind: 'message', runId: 'old', data: { role: 'assistant', content: [{ type: 'text', text: '<script>unsafe()</script>' }] } }]
    mocks.start.mockResolvedValueOnce({})
    const rendered = view()
    expect(rendered.container.querySelector('script')).toBeNull()
    expect(screen.getByText('<script>unsafe()</script>')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Continue from this run' }))
    expect(mocks.start).not.toHaveBeenCalled()
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('')
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Check existing output before continuing' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })) })
    expect(mocks.start.mock.calls[0]![0].payload).toMatchObject({ purpose: 'recovery', resumesRunId: 'old', prompt: 'Check existing output before continuing' })
  })
})
