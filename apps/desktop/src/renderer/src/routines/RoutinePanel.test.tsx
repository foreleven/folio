// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoutinePanel } from './RoutinePanel'

const mocks = vi.hoisted(() => ({
  routinesQuery: { kind: 'routines' },
  executionsQuery: { kind: 'executions' },
  routines: [] as unknown[],
  executions: [] as unknown[],
  refresh: vi.fn(),
  cancel: vi.fn(),
  retry: vi.fn()
}))

vi.mock('@effect/atom-react', () => ({
  useAtomRefresh: () => mocks.refresh,
  useAtomSet: (atom: unknown) => atom === 'cancel' ? mocks.cancel : atom === 'knowledge-retry' ? mocks.retry : vi.fn(),
  useAtomValue: (query: { kind?: string }) => ({
    _tag: 'Success',
    value: query.kind === 'config' ? { timeZone: 'Asia/Shanghai' } : query.kind === 'routines' ? mocks.routines : mocks.executions
  })
}))
vi.mock('../rpc/task-rpc', () => ({
  TaskRpcClient: {
    query: (name: string) => (name === 'routines.list' ? mocks.routinesQuery : mocks.executionsQuery),
    saveRoutine: {},
    runRoutine: {},
    prepareRoutine: {},
    cancelRun: 'cancel',
    cancelIngestion: {},
    retryIngestion: {},
    retryKnowledgeRun: 'knowledge-retry'
  }
}))
vi.mock('../rpc/config-rpc', () => ({ ConfigRpcClient: { watch: { kind: 'config' } } }))
vi.mock('../preferences', () => ({ useLocale: () => 'zh-CN' }))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
  mocks.routines = []
  mocks.executions = []
})

describe('Routine details', () => {
  it('shows event Task history by creation date without a synthetic window and permits retry', async () => {
    mocks.routines = [{ id: 'raw-intake', name: 'Raw knowledge intake', type: 'agent', configuration: {
      goal: 'Organize raws', agent: 'codex', model: null, skillIds: [], integrationIds: [], resourceIds: [] },
      trigger: { type: 'event', signal: 'raws-changed' }, enabled: true, revision: 1,
      nextTriggerAt: null, lastTriggerAt: null, createdAt: 1, updatedAt: 1 }]
    const createdAt = Date.parse('2026-09-27T17:15:40Z')
    mocks.executions = [{ routineId: 'raw-intake', taskId: 'knowledge-task', type: 'agent', cancelRequested: false,
      runId: 'interrupted-run', routineDate: null, triggerTime: createdAt, createdAt,
      windowStart: null, windowEnd: null, timeZone: null, routineRevision: 1, model: null,
      status: 'interrupted', startedAt: createdAt, endedAt: createdAt + 300_000, updatedAt: createdAt + 300_000 }]
    mocks.retry.mockResolvedValue({})
    render(<RoutinePanel />)
    fireEvent.click(screen.getByRole('button', { name: '打开 Raw knowledge intake Routine 详情' }))
    expect(screen.getByText('Task knowledg')).toBeTruthy()
    expect(screen.getByText('已中断')).toBeTruthy()
    expect(screen.getAllByText(/9月28日/).length).toBeGreaterThan(0)
    expect(screen.getByText('raws 变化触发')).toBeTruthy()
    expect(screen.queryByText(/→/)).toBeNull()
    expect(screen.queryByRole('button', { name: '运行一次' })).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试' })) })
    expect(mocks.retry).toHaveBeenCalledWith({ payload: { taskId: 'knowledge-task', previousRunId: 'interrupted-run', retryRunId: expect.any(String) } })
  })

  it('refreshes background execution results and releases the timer on unmount', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-19T12:00:00.000Z'))
    mocks.routines = [{ id: 'imap', name: 'IMAP', type: 'agent', configuration: { goal: 'Review mail', agent: 'codex', model: null,
      skillIds: [], integrationIds: [], resourceIds: [] }, trigger: { type: 'schedule', intervalMinutes: 1440, timeZone: 'UTC' },
      enabled: true, revision: 1, nextTriggerAt: null, lastTriggerAt: null, createdAt: 1, updatedAt: 1 }]
    const execution = { routineId: 'imap', taskId: 'task', routineDate: '2026-09-19', triggerTime: 1,
      runId: '33333333-3333-4333-8333-333333333333', type: 'agent', cancelRequested: false,
      windowStart: 0, windowEnd: 1,
      timeZone: 'UTC', routineRevision: 1, model: null, startedAt: 1, endedAt: null, createdAt: 1, updatedAt: 1 }
    mocks.executions = [{ ...execution, status: 'preparing' }]
    const view = render(<RoutinePanel />)
    fireEvent.click(screen.getByRole('button', { name: '打开 IMAP Routine 详情' }))
    expect(screen.getByText('准备中')).toBeTruthy()
    mocks.refresh.mockImplementation(() => { mocks.executions = [{ ...execution, status: 'failed', endedAt: 2 }] })
    act(() => { vi.advanceTimersByTime(1000) })
    expect(mocks.refresh).toHaveBeenCalled()
    view.rerender(<RoutinePanel />)
    expect(screen.getByText('失败')).toBeTruthy()
    expect(screen.queryByText('准备中')).toBeNull()
    // Polling must also discover scheduler-triggered executions after the last one ended.
    mocks.refresh.mockClear()
    act(() => { vi.advanceTimersByTime(1000) })
    expect(mocks.refresh).toHaveBeenCalled()
    view.unmount()
    mocks.refresh.mockClear()
    act(() => { vi.advanceTimersByTime(1000) })
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('shows a stop action for an active Agent execution', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-19T12:00:00.000Z'))
    mocks.routines = [{ id: 'imap', name: 'IMAP', type: 'agent', configuration: { goal: 'Review mail', agent: 'codex', model: null,
      skillIds: [], integrationIds: [], resourceIds: [] }, trigger: { type: 'schedule', intervalMinutes: 60, timeZone: 'UTC' }, enabled: true, revision: 1,
      nextTriggerAt: null, lastTriggerAt: null, createdAt: 1, updatedAt: 1 }]
    mocks.executions = [{ routineId: 'imap', taskId: 'task', type: 'agent', cancelRequested: false, runId: '33333333-3333-4333-8333-333333333333', routineDate: '2026-09-19',
      triggerTime: 1, windowStart: 0, windowEnd: 1,
      timeZone: 'UTC', routineRevision: 1, model: null, status: 'running', startedAt: 1, endedAt: null, createdAt: 1, updatedAt: 1 }]
    render(<RoutinePanel />)
    fireEvent.click(screen.getByRole('button', { name: '打开 IMAP Routine 详情' }))
    expect(screen.getByRole('button', { name: '停止执行' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '停止执行' }))
    expect(mocks.cancel).toHaveBeenCalledWith({ payload: { taskId: 'task', runId: '33333333-3333-4333-8333-333333333333' } })
  })

  it('opens the full prompt in a dialog from the detail page', () => {
    mocks.routines = [
      {
        id: '00000000-0000-4000-8000-000000000001',
        name: '每日邮件整理',
        type: 'agent',
        configuration: { goal: '第一步：读取今天的邮件。\n第二步：整理行动项和截止时间。', agent: 'codex', model: null,
          skillIds: [], integrationIds: [], resourceIds: [] },
        trigger: { type: 'schedule', intervalMinutes: 1440, timeZone: 'Asia/Shanghai' },
        enabled: true,
        revision: 1,
        nextTriggerAt: null,
        lastTriggerAt: null,
        createdAt: 1,
        updatedAt: 1
      }
    ]

    render(<RoutinePanel />)
    fireEvent.click(screen.getByRole('button', { name: '打开 每日邮件整理 Routine 详情' }))
    // A day without a scheduled window must not be inferred as missing history.
    expect(screen.getAllByRole('button').length).toBeLessThan(50)
    expect(screen.queryByText('这一天没有执行记录')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '查看全部 Prompt' }))

    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('第一步：读取今天的邮件。')
    expect(dialog.textContent).toContain('第二步：整理行动项和截止时间。')
  })
})
