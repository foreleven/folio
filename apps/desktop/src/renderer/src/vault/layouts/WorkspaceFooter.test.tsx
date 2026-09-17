// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceFooter } from './WorkspaceFooter'

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), query: {} as any }))
vi.mock('@effect/atom-react', () => ({
  useAtomValue: () => mocks.query,
  useAtomRefresh: () => mocks.refresh
}))
vi.mock('../../rpc/execution-rpc', () => ({ ExecutionRpcClient: { status: 'global' } }))
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks() })
const view = () => render(<WorkspaceFooter chinese vault={{ id: 'a', name: 'Vault A', path: '/a' }} sectionLabel="Tasks" />)

it('shows global counts, partial availability, and refreshes while mounted', () => {
  vi.useFakeTimers()
  mocks.query = { _tag: 'Success', value: { queued: 4, preparing: 1, running: 2, succeeded: 7, failed: 1, interrupted: 1, cancelled: 0, vaults: 3, unavailableVaults: 1, concurrency: 2 } }
  const component = view()
  expect(screen.getByRole('status').textContent).toContain('全局任务 · 执行 2 · 准备 1 · 排队 4')
  expect(screen.getByRole('status').textContent).toContain('1 个 Vault 不可用')
  expect(screen.getByRole('status').textContent).toContain('失败/中断 2')
  act(() => vi.advanceTimersByTime(2000))
  expect(mocks.refresh).toHaveBeenCalledTimes(1)
  component.unmount()
  act(() => vi.advanceTimersByTime(2000))
  expect(mocks.refresh).toHaveBeenCalledTimes(1)
})

it('does not present a failed query as an empty queue', () => {
  mocks.query = { _tag: 'Failure' }
  view()
  expect(screen.getByRole('status').textContent).toBe('全局任务状态不可用')
})
