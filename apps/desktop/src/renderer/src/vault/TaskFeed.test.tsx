// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TaskFeed } from './TaskFeed'

const mocks = vi.hoisted(() => ({ feed: vi.fn() }))
vi.mock('@effect/atom-react', () => ({
  useAtomSet: () => mocks.feed,
  useAtomValue: () => ({ _tag: 'Success', value: { timeZone: 'Asia/Shanghai' } })
}))
vi.mock('../rpc/task-rpc', () => ({ TaskRpcClient: { feed: 'feed' } }))
vi.mock('../rpc/config-rpc', () => ({ ConfigRpcClient: { watch: 'config' } }))
vi.mock('../preferences', () => ({ useLocale: () => 'en' }))

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks() })

const agent = {
  id: '11111111-1111-4111-8111-111111111111', type: 'agent', createdAt: Date.parse('2026-09-21T16:30:00Z'),
  state: 'active', configuration: { goal: 'Remember the decision', agent: 'codex' }, summary: {
    type: 'agent', outcome: 'succeeded', discovery: { content: [{ type: 'text', text: 'The decision is recorded.' }], incomplete: false },
    publication: { state: 'pending', saveOperationId: null, synchronizationId: null }
  }
}
const ingestion = {
  id: '22222222-2222-4222-8222-222222222222', type: 'ingestion', createdAt: Date.parse('2026-09-21T15:30:00Z'),
  state: 'completed', configuration: { integrationId: 'lark', resourceId: 'im' }, receipt: { state: 'succeeded' }, summary: {
    type: 'ingestion', outcome: 'succeeded', changedFileCount: 0, rawsChanged: false,
    windowStart: Date.parse('2026-09-21T15:00:00Z'), windowEnd: Date.parse('2026-09-21T15:30:00Z'), timeZone: 'Asia/Shanghai',
    publication: { state: 'not-required', saveOperationId: null, synchronizationId: null }
  }
}

it('shows one read-only entry per Task, groups by the saved time zone, and loads older Tasks', async () => {
  mocks.feed.mockImplementation(async ({ payload }: { payload: { cursor: unknown } }) => payload.cursor === null
    ? { entries: [{ task: agent, latestRun: { state: 'succeeded' }, routineName: null, schedule: null }],
      nextCursor: { createdAt: agent.createdAt, id: agent.id } }
    : { entries: [{ task: ingestion, latestRun: null, routineName: null, schedule: null }], nextCursor: null })
  render(<TaskFeed />)
  await waitFor(() => expect(screen.getByText('The decision is recorded.')).toBeTruthy())
  expect(screen.getByRole('region', { name: '2026-09-22' })).toBeTruthy()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Load earlier Tasks' })) })
  expect(screen.getByRole('region', { name: '2026-09-21' })).toBeTruthy()
  expect(screen.getByText('No raw file changes')).toBeTruthy()
  expect(mocks.feed).toHaveBeenCalledWith({ payload: { cursor: { createdAt: agent.createdAt, id: agent.id } } })
  expect(screen.queryByRole('link')).toBeNull()
})

it('shows a cancelled Task without a Run as cancelled, not pending', async () => {
  mocks.feed.mockResolvedValue({ entries: [{ task: { ...agent, state: 'cancelled', summary: null },
    latestRun: null, routineName: null, schedule: null }], nextCursor: null })
  render(<TaskFeed />)
  await waitFor(() => expect(screen.getByText('Cancelled')).toBeTruthy())
  expect(screen.queryByText('Pending')).toBeNull()
})

it('refreshes an already loaded older page when its Task result changes', async () => {
  let poll: (() => void) | undefined
  vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay) => {
    if (delay === 4000) poll = callback as () => void
    return 1 as unknown as ReturnType<typeof setInterval>
  })
  let changed = false
  mocks.feed.mockImplementation(async ({ payload }: { payload: { cursor: unknown } }) => payload.cursor === null
    ? { entries: [{ task: agent, latestRun: { state: 'succeeded' }, routineName: null, schedule: null }],
      nextCursor: { createdAt: agent.createdAt, id: agent.id } }
    : { entries: [{ task: { ...ingestion, summary: changed ? { ...ingestion.summary, rawsChanged: true, changedFileCount: 1 } : ingestion.summary },
      latestRun: null, routineName: null, schedule: null }], nextCursor: null })
  render(<TaskFeed />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Load earlier Tasks' })).toBeTruthy())
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Load earlier Tasks' })) })
  expect(screen.getByText('No raw file changes')).toBeTruthy()
  changed = true
  await act(async () => { poll?.(); await Promise.resolve() })
  await waitFor(() => expect(screen.getByText('1 raw file(s) changed')).toBeTruthy())
})
