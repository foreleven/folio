// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { TaskRecord } from '../../../shared/harness'
import { TaskSessions } from './TaskSessions'

const mocks = vi.hoisted(() => ({
  retry: vi.fn(), refresh: vi.fn(), runs: [] as Array<{ id: string; purpose: string; state: string }>
}))
vi.mock('@effect/atom-react', () => ({
  useAtomRefresh: () => mocks.refresh,
  useAtomSet: (atom: string) => atom === 'retry-knowledge' ? mocks.retry : vi.fn(),
  useAtomValue: (query: { method?: string }) => query.method === 'tasks.get'
    ? { _tag: 'Success', value: { routine: null, sessions: [], runs: mocks.runs } }
    : { _tag: 'Success', value: { models: [], configuredProviders: [] } }
}))
vi.mock('../rpc/task-rpc', () => ({ TaskRpcClient: { query: (method: string) => ({ method }), retryKnowledgeRun: 'retry-knowledge' } }))
vi.mock('../rpc/model-rpc', () => ({ modelCatalogAtom: {}, modelsAtom: {} }))
vi.mock('../preferences', () => ({ useLocale: () => 'en' }))
vi.mock('./TaskConversation', () => ({ TaskConversation: () => null }))
vi.mock('./TaskWikiChangesPanel', () => ({ TaskWikiChangesPanel: () => null }))

const task = {
  id: 'knowledge-task', type: 'agent', state: 'active',
  configuration: { agent: 'codex', rawInput: { fromCommit: null, toCommit: 'a'.repeat(40) } }
} as Extract<TaskRecord, { type: 'agent' }>

afterEach(() => { cleanup(); vi.clearAllMocks(); mocks.runs = [] })

it('retries a failed Knowledge Run with the same frozen Task and stable request identity', async () => {
  mocks.runs = [{ id: 'failed-run', purpose: 'execution', state: 'failed' }]
  mocks.retry.mockRejectedValueOnce(new Error('lost response')).mockResolvedValueOnce({})
  render(<TaskSessions task={task} />)
  expect(screen.queryByRole('button', { name: 'New session' })).toBeNull()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry knowledge intake' })))
  const first = mocks.retry.mock.calls[0]![0]
  expect(first.payload).toMatchObject({ taskId: task.id, previousRunId: 'failed-run', retryRunId: expect.any(String) })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry knowledge intake' })))
  expect(mocks.retry.mock.calls[1]![0]).toEqual(first)
})
