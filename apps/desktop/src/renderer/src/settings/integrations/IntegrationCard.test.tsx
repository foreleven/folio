// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IntegrationView } from '../../../../shared/integration'
import { IntegrationCard } from './IntegrationCard'

afterEach(cleanup)
const base: IntegrationView = {
  id: 'lark', name: 'Lark', busy: false, record: null,
  description: 'Connect conversations and email.', logo: 'data:image/svg+xml,%3Csvg%2F%3E', homepage: 'https://www.larksuite.com/',
  actions: [{ id: 'authorize', label: 'Authorize' }], resources: [{ id: 'im', name: 'Messages' }, { id: 'email', name: 'Email' }]
}
/** Creates a card around a committed server snapshot with observable action handlers. */
function show(view: IntegrationView = base, locale: 'en' | 'zh-CN' = 'en') {
  const handlers = { onInstall: vi.fn(), onCheck: vi.fn(), onAction: vi.fn(), onOpenAuthorization: vi.fn() }
  const result = render(<IntegrationCard integration={view} locale={locale} pending={false} error={false} {...handlers} />)
  return { ...result, ...handlers }
}
const installed = (state: string): IntegrationView => ({ ...base, record: {
  id: 'lark', state, data: {}, resources: base.resources, actionIds: ['authorize'], error: null, createdAt: 1, updatedAt: 2
} })

describe('IntegrationCard', () => {
  it('renders another provider’s metadata and install control without Lark branding', () => {
    const ui = show({ ...base, id: 'notes', name: 'Notes', description: 'Bring your notes into Folio.',
      logo: 'data:image/png;base64,logo', homepage: 'https://notes.example', resources: [{ id: 'notes', name: 'Personal notes' }] })
    expect(screen.getByRole('img', { name: 'Notes logo' }).getAttribute('src')).toBe('data:image/png;base64,logo')
    expect(screen.getByRole('link', { name: 'Notes' }).getAttribute('href')).toBe('https://notes.example')
    expect(screen.getByText('Bring your notes into Folio.')).toBeTruthy()
    expect(screen.getByText('Personal notes')).toBeTruthy()
    expect(screen.queryByText(/Lark/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Install Notes' }))
    expect(ui.onInstall).toHaveBeenCalledOnce()
  })
  it('uses another provider’s action label without assuming Lark setup steps', () => {
    show({ ...installed('login_required'), id: 'notes', name: 'Notes', actions: [{ id: 'authorize', label: 'Connect Notes account' }] })
    expect(screen.getByRole('button', { name: 'Connect Notes account' })).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Setup progress' })).toBeNull()
  })
  it('does not install on render and requires the explicit install button', () => {
    const ui = show()
    expect(ui.onInstall).not.toHaveBeenCalled()
    expect(screen.getByText('Not installed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Install Lark' }))
    expect(ui.onInstall).toHaveBeenCalledOnce()
  })
  it('offers only actions from the last check', () => {
    const ui = show(installed('login_required'))
    fireEvent.click(screen.getByRole('button', { name: 'Authorize Lark' }))
    expect(ui.onAction).toHaveBeenCalledWith('authorize')
    expect(screen.queryByRole('button', { name: 'Install Lark' })).toBeNull()
  })
  it('shows waiting progress and opens authorization through the host rather than navigating the renderer', () => {
    const ui = show({ ...installed('waiting_for_user'), busy: true })
    fireEvent.click(screen.getByRole('button', { name: /Open authorization page/ }))
    expect(ui.onOpenAuthorization).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Authorize Lark' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Check status' }).getAttribute('aria-disabled')).toBe('true')
  })
  it('renders connected state in Chinese and retains a manual recheck', () => {
    const connected = installed('ready')
    const ui = show({ ...connected, record: { ...connected.record!, actionIds: [] } }, 'zh-CN')
    expect(screen.getByText('已连接')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '检查状态' }))
    expect(ui.onCheck).toHaveBeenCalledOnce()
  })
  it('exposes a persisted failure and a usable retry action', () => {
    const view = installed('login_required')
    show({ ...view, record: { ...view.record!, error: 'request failed' } })
    expect(screen.getByRole('alert').textContent).toContain('Couldn’t complete')
    expect(screen.getByRole('button', { name: 'Authorize Lark' }).hasAttribute('disabled')).toBe(false)
  })
  it('reveals secondary details on request without installing or checking', () => {
    const ui = show()
    const toggle = screen.getByRole('button', { name: 'Details' })
    const panel = document.getElementById(toggle.getAttribute('aria-controls')!)!
    expect(panel.hidden).toBe(true)
    expect(screen.getByText(/Installs missing Lark CLI/).closest('[hidden]')).toBeNull()
    fireEvent.click(toggle)
    expect(panel.hidden).toBe(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle)
    expect(panel.hidden).toBe(true)
    expect(ui.onInstall).not.toHaveBeenCalled()
    expect(ui.onCheck).not.toHaveBeenCalled()
  })
  it('automatically reveals failures and never labels an errored ready record as connected', () => {
    const view = installed('ready')
    show({ ...view, record: { ...view.record!, error: 'request failed' } })
    expect(screen.getByRole('alert').closest('[hidden]')).toBeNull()
    expect(screen.queryByText('Connected')).toBeNull()
    expect(screen.getByRole('button', { name: 'Details' }).getAttribute('aria-expanded')).toBe('true')
  })
  it('retains keyboard focus in the row when a completed action disappears', () => {
    const ui = show(installed('login_required'))
    screen.getByRole('button', { name: 'Authorize Lark' }).focus()
    const view = installed('ready')
    ui.rerender(<IntegrationCard integration={{ ...view, record: { ...view.record!, actionIds: [] } }} locale="en" pending={false} error={false} {...ui} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Details' }))
  })

})
