// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RoutineSchedules } from './RoutineSchedules'

const mocks = vi.hoisted(() => ({ save: vi.fn(), remove: vi.fn(), zone: vi.fn(), refresh: vi.fn(),
  settings: { timeZone: 'Asia/Shanghai' as string | null, schedules: [] as { routineId: string; revision: number; time: string; nextAt: number }[] } }))
vi.mock('@effect/atom-react', () => ({ useAtomRefresh: () => mocks.refresh,
  useAtomValue: () => ({ _tag: 'Success', value: mocks.settings }),
  useAtomSet: (name: string) => name === 'save' ? mocks.save : name === 'zone' ? mocks.zone : mocks.remove }))
vi.mock('../rpc/task-rpc', () => ({ TaskRpcClient: { query: () => 'settings', saveSchedule: 'save', setTimeZone: 'zone', removeSchedule: 'remove' } }))
vi.mock('../preferences', () => ({ useLocale: () => 'en' }))
const routines = [{ id: 'routine', revision: 1, createdAt: 0, updatedAt: 0,
  definition: { name: 'Daily notes', prompt: 'Fixture', enabled: true, model: null,
    configuration: { agent: 'codex' as const, integrationIds: [], skillIds: [] } } }]
afterEach(() => { cleanup(); vi.resetAllMocks(); mocks.settings = { timeZone: 'Asia/Shanghai', schedules: [] } })

it('preserves the original time and revision across refresh, failure and explicit retry', async () => {
  mocks.settings.schedules = [{ routineId: 'routine', revision: 1, time: '09:00', nextAt: 1789002000000 }]
  const view = render(<RoutineSchedules vaultId="vault" routines={routines} />)
  expect(mocks.save).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Edit daily time' }))
  fireEvent.change(screen.getByLabelText('Daily time'), { target: { value: '10:30' } })
  mocks.settings.schedules = [{ routineId: 'routine', revision: 2, time: '11:00', nextAt: 1789009200000 }]
  view.rerender(<RoutineSchedules vaultId="vault" routines={routines} />)
  expect((screen.getByLabelText('Daily time') as HTMLInputElement).value).toBe('10:30')
  mocks.save.mockRejectedValueOnce(new Error('lost reply'))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save schedule settings' })))
  expect(screen.getByRole('alert').textContent).toContain('Input is retained')
  const request = mocks.save.mock.calls[0]![0]
  expect(request.payload.input).toEqual({ routineId: 'routine', time: '10:30', expectedRevision: 1 })
  mocks.save.mockResolvedValueOnce({})
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save schedule settings' })))
  expect(mocks.save.mock.calls[1]![0]).toEqual(request)
  expect(screen.queryByLabelText('Daily time')).toBeNull()
})

it('requires a saved timezone and validates a named zone before submitting', async () => {
  mocks.settings.timeZone = null
  render(<RoutineSchedules vaultId="vault" routines={routines} />)
  expect((screen.getByRole('button', { name: 'Edit daily time' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Set timezone' }))
  fireEvent.change(screen.getByLabelText('Named timezone'), { target: { value: 'bad/zone' } })
  expect((screen.getByRole('button', { name: 'Save schedule settings' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Named timezone'), { target: { value: 'Asia/Shanghai' } })
  mocks.zone.mockResolvedValueOnce(undefined)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save schedule settings' })))
  expect(mocks.zone).toHaveBeenCalledWith({ payload: { vaultId: 'vault', timeZone: 'Asia/Shanghai', expected: null } })
  expect(mocks.save).not.toHaveBeenCalled()
})

it('blocks overlapping deletion and preserves the schedule revision', async () => {
  mocks.settings.schedules = [{ routineId: 'routine', revision: 3, time: '09:00', nextAt: 1789002000000 }]
  let resolve!: () => void
  mocks.remove.mockImplementation(() => new Promise<void>(done => { resolve = done }))
  render(<RoutineSchedules vaultId="vault" routines={routines} />)
  fireEvent.click(screen.getByRole('button', { name: 'Edit daily time' }))
  const button = screen.getByRole('button', { name: 'Remove daily plan' })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(mocks.remove).toHaveBeenCalledOnce()
  expect(mocks.remove).toHaveBeenCalledWith({ payload: { vaultId: 'vault', routineId: 'routine', revision: 3 } })
  await act(async () => resolve())
  expect(mocks.refresh).toHaveBeenCalled()
})
