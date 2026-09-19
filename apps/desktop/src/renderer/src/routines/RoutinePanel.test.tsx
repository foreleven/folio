// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoutinePanel } from './RoutinePanel'

const mocks = vi.hoisted(() => ({
  routinesQuery: { kind: 'routines' },
  executionsQuery: { kind: 'executions' },
  routines: [] as unknown[],
  executions: [] as unknown[],
  refresh: vi.fn()
}))

vi.mock('@effect/atom-react', () => ({
  useAtomRefresh: () => mocks.refresh,
  useAtomSet: () => vi.fn(),
  useAtomValue: (query: { kind?: string }) => ({
    _tag: 'Success',
    value: query.kind === 'routines' ? mocks.routines : mocks.executions
  })
}))
vi.mock('../rpc/task-rpc', () => ({
  TaskRpcClient: {
    query: (name: string) => (name === 'routines.list' ? mocks.routinesQuery : mocks.executionsQuery),
    saveRoutine: {},
    runRoutine: {},
    prepareRoutine: {}
  }
}))
vi.mock('../preferences', () => ({ useLocale: () => 'zh-CN' }))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
  mocks.routines = []
  mocks.executions = []
})

describe('Routine details', () => {
  it('refreshes background execution results and releases the timer on unmount', () => {
    vi.useFakeTimers()
    mocks.routines = [{ id: 'imap', name: 'IMAP', prompt: 'Review mail', agent: 'codex', model: null,
      skillIds: [], integrationIds: [], resourceIds: [], intervalMinutes: 1440, timeZone: 'UTC',
      enabled: true, revision: 1, nextTriggerAt: null, lastTriggerAt: null, createdAt: 1, updatedAt: 1 }]
    const execution = { routineId: 'imap', taskId: 'task', routineDate: '2026-09-19', triggerTime: 1,
      firstTriggerTime: 1, triggerCount: 1, isEnd: false, windowStart: 0, windowEnd: 1,
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

  it('opens the full prompt in a dialog from the detail page', () => {
    mocks.routines = [
      {
        id: '00000000-0000-4000-8000-000000000001',
        name: '每日邮件整理',
        prompt: '第一步：读取今天的邮件。\n第二步：整理行动项和截止时间。',
        agent: 'codex',
        model: null,
        skillIds: [],
        integrationIds: [],
        resourceIds: [],
        intervalMinutes: 1440,
        timeZone: 'Asia/Shanghai',
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
    // Long-lived Routines must not mount every historical date at once.
    expect(screen.getAllByRole('button').length).toBeLessThan(50)
    fireEvent.click(screen.getByRole('button', { name: '显示更早日期' }))
    expect(screen.getAllByRole('button').length).toBeLessThan(90)
    fireEvent.click(screen.getByRole('button', { name: '查看全部 Prompt' }))

    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('第一步：读取今天的邮件。')
    expect(dialog.textContent).toContain('第二步：整理行动项和截止时间。')
  })
})
