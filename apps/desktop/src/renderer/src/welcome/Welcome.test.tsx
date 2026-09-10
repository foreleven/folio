// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Welcome } from './Welcome'

const state = vi.hoisted(() => ({
  config: {
    _tag: 'Success',
    value: {
      vaults: [
        { id: 'first', name: 'Research', path: '/Users/example/Documents/research' },
        { id: 'second', name: 'Notes', path: '/Users/example/Documents/notes' }
      ]
    }
  } as { _tag: string; value?: { vaults: Array<{ id: string; name: string; path: string }> } },
  opening: null as string | null,
  failed: false,
  openVault: vi.fn().mockResolvedValue(undefined),
  refresh: vi.fn()
}))

vi.mock('@effect/atom-react', () => ({
  useAtomRefresh: () => state.refresh,
  useAtomValue: () => state.config
}))
vi.mock('../preferences', () => ({ useLocale: () => 'en' }))
vi.mock('../rpc/config-rpc', () => ({ ConfigRpcClient: { watch: {} } }))
vi.mock('../vault/use-vault-open', () => ({
  useVaultOpen: () => ({ openVault: state.openVault, opening: state.opening, failed: state.failed })
}))

beforeEach(() => {
  state.config = {
    _tag: 'Success',
    value: {
      vaults: [
        { id: 'first', name: 'Research', path: '/Users/example/Documents/research' },
        { id: 'second', name: 'Notes', path: '/Users/example/Documents/notes' }
      ]
    }
  }
  state.opening = null
  state.failed = false
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Welcome', () => {
  it('keeps the primary folder action ahead of newest-first recent vaults', () => {
    render(<Welcome />)
    const sections = screen.getAllByRole('region')
    expect(within(sections[0]).getByRole('heading', { name: 'GET STARTED' })).toBeTruthy()
    fireEvent.click(within(sections[0]).getByRole('button', { name: 'Open Vault' }))
    expect(state.openVault).toHaveBeenCalledWith()

    const recentButtons = within(sections[1]).getAllByRole('button')
    expect(recentButtons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Notes: /Users/example/Documents/notes',
      'Research: /Users/example/Documents/research'
    ])
    fireEvent.click(recentButtons[0])
    expect(state.openVault).toHaveBeenLastCalledWith('second')
  })

  it('renders geometry-preserving loading, empty, and retryable failure states', () => {
    state.config = { _tag: 'Initial' }
    const ui = render(<Welcome />)
    expect(screen.getByRole('status', { name: 'Loading vaults' }).children).toHaveLength(3)

    state.config = { _tag: 'Success', value: { vaults: [] } }
    ui.rerender(<Welcome />)
    expect(screen.getByText('No vaults yet. Open a folder to get started.')).toBeTruthy()

    state.config = { _tag: 'Failure' }
    ui.rerender(<Welcome />)
    expect(screen.getByRole('alert').textContent).toContain('Could not load your vaults.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(state.refresh).toHaveBeenCalledOnce()
  })

  it('holds every vault action stable while an opening operation is active', () => {
    state.opening = 'second'
    state.failed = true
    render(<Welcome />)
    expect(screen.getByRole('status').textContent).toBe('Opening vault…')
    expect(screen.getByRole('alert').textContent).toContain('Could not open the vault.')
    for (const button of screen.getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true)
  })
})
