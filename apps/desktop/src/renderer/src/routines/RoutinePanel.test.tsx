// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
  vi.clearAllMocks()
  mocks.routines = []
  mocks.executions = []
})

describe('Routine details', () => {
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

    render(<RoutinePanel vaultId="vault" />)
    fireEvent.click(screen.getByRole('button', { name: '打开 每日邮件整理 Routine 详情' }))
    fireEvent.click(screen.getByRole('button', { name: '查看全部 Prompt' }))

    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('第一步：读取今天的邮件。')
    expect(dialog.textContent).toContain('第二步：整理行动项和截止时间。')
  })
})
