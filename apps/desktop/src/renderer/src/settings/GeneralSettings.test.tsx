// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GeneralSettings } from './GeneralSettings'

const { update } = vi.hoisted(() => ({ update: vi.fn() }))
vi.mock('@effect/atom-react', () => ({
  useAtomRefresh: () => vi.fn(),
  useAtomSet: () => update,
  useAtomValue: () => ({ _tag: 'Success', value: { theme: 'light', language: 'en', vaults: [] } })
}))
vi.mock('../rpc/config-rpc', () => ({ configAtom: {}, ConfigRpcClient: { update: {} } }))
vi.mock('../preferences', () => ({ useLocale: () => 'en' }))
afterEach(() => { cleanup(); vi.resetAllMocks() })

describe('GeneralSettings', () => {
  it('keeps focus and committed values while a save is pending, and rejects overlapping changes', async () => {
    let finish!: () => void
    update.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    render(<GeneralSettings />)
    const dark = screen.getByRole('button', { name: 'Dark' })
    dark.focus()
    fireEvent.click(dark)
    expect(document.activeElement).toBe(dark)
    expect(screen.getByRole('status').textContent).toBe('Saving…')
    expect(screen.getByRole('button', { name: 'Light' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '简体中文' }))
    expect(update).toHaveBeenCalledTimes(1)
    await act(async () => { finish() })
    expect(screen.getByRole('status').textContent).toBe('Saved')
    expect(document.activeElement).toBe(dark)
  })

  it('keeps the previous preference and exposes a local failure that can be retried', async () => {
    update.mockRejectedValueOnce(new Error('save failed')).mockResolvedValueOnce(undefined)
    render(<GeneralSettings />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dark' })) })
    expect(screen.getByRole('alert').textContent).toContain('Couldn’t save changes')
    expect(screen.getByRole('button', { name: 'Light' }).getAttribute('aria-pressed')).toBe('true')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dark' })) })
    expect(update).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('Saved')
  })
})
