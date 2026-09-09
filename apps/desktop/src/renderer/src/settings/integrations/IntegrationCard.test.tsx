// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IntegrationView } from '../../../../shared/integration'
import { IntegrationCard } from './IntegrationCard'

afterEach(cleanup)
const base: IntegrationView = {
  id: 'notes', name: 'Notes', busy: false, record: null,
  description: { en: 'Bring your notes into Folio.', 'zh-CN': '连接你的笔记。' },
  logo: 'data:image/svg+xml,%3Csvg%2F%3E', homepage: 'https://notes.example',
  states: {
    needs_key: { kind: 'attention', label: { en: 'Add credentials', 'zh-CN': '需要凭据' } },
    custom_wait: { kind: 'waiting', label: 'Waiting for approval', description: 'Complete setup in Notes.' },
    synced: { kind: 'ready', label: { en: 'Connected', 'zh-CN': '已连接' } }
  },
  actions: [{ id: 'configure', label: 'Configure Notes' }, { id: 'open', label: 'Continue in Notes' }],
  resources: [{ id: 'pages', name: { en: 'Personal notes', 'zh-CN': '个人笔记' } }]
}
/** Supplies a committed snapshot with a provider-specific state that the card cannot know in advance. */
const installed = (state = 'needs_key'): IntegrationView => ({ ...base, record: {
  id: 'notes', state, data: {}, resources: base.resources,
  actions: [{ id: 'configure', type: 'callback', primary: true }], error: null, createdAt: 1, updatedAt: 2
} })
/** Observes real UI handlers without loading Electron or a provider implementation. */
function show(view: IntegrationView = base, locale: 'en' | 'zh-CN' = 'en') {
  const handlers = { onInstall: vi.fn(), onInspect: vi.fn(), onAction: vi.fn().mockResolvedValue(undefined) }
  const result = render(<IntegrationCard integration={view} locale={locale} pending={false} error={false} {...handlers} />)
  return { ...result, ...handlers }
}
/** Opens the accessible menu and waits for its portal before selecting an item. */
async function menu(name: string) {
  fireEvent.click(screen.getByRole('button', { name: /More actions|更多操作/ }))
  fireEvent.click(await screen.findByRole('menuitem', { name }))
}
const configured: IntegrationView = {
  ...installed(), actions: [{ id: 'configure', label: 'Configure Notes', description: 'Enter your account credentials.', fields: [
    { id: 'accessKey', label: 'AccessKey', type: 'text', required: true },
    { id: 'secretKey', label: 'SecretKey', type: 'password', required: true }
  ] }]
}

describe('IntegrationCard', () => {
  it('renders provider metadata and only installs after an explicit click', () => {
    const ui = show()
    expect(screen.getByRole('img', { name: 'Notes logo' }).getAttribute('src')).toBe(base.logo)
    expect(screen.getByText('Bring your notes into Folio.')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('Not installed')
    expect(ui.onInstall).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    expect(ui.onInstall).toHaveBeenCalledOnce()
  })

  it('uses the declared primary action instead of array order', async () => {
    const view = installed()
    const ui = show({ ...view, actions: [...view.actions, { id: 'alternative', label: 'Alternative setup' }], record: { ...view.record!, actions: [
      { id: 'alternative', type: 'callback' }, { id: 'configure', type: 'callback', primary: true }
    ] } })
    expect(screen.queryByRole('button', { name: 'Alternative setup' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Configure Notes' }))
    expect(ui.onAction).toHaveBeenCalledWith('configure')
    await menu('Alternative setup')
    expect(ui.onAction).toHaveBeenCalledWith('alternative')
  })

  it('keeps browser actions accessible while an authorization job is busy', async () => {
    const view = installed('custom_wait')
    const ui = show({ ...view, busy: true, record: { ...view.record!, actions: [{ id: 'open', type: 'open-url', primary: true, url: 'https://notes.example/connect' }] } })
    expect(screen.getByText('Complete setup in Notes.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Continue in Notes/ }))
    expect(ui.onAction).toHaveBeenCalledWith('open')
    fireEvent.click(screen.getByRole('button', { name: /More actions/ }))
    expect((await screen.findByRole('menuitem', { name: 'Check status' })).getAttribute('aria-disabled')).toBe('true')
    expect(ui.onInspect).not.toHaveBeenCalled()
  })

  it('uses provider translations and exposes details through a dialog', async () => {
    const view = installed('synced')
    const ui = show({ ...view, record: { ...view.record!, actions: [] } }, 'zh-CN')
    expect(screen.getByRole('status').textContent).toContain('已连接')
    await menu('详情')
    const dialog = await screen.findByRole('dialog', { name: 'Notes' })
    expect(dialog.textContent).toContain('个人笔记')
    expect(screen.getByRole('link', { name: /Notes/ }).getAttribute('href')).toBe(base.homepage)
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await menu('检查状态')
    expect(ui.onInspect).toHaveBeenCalledOnce()
  })

  it('keeps failures visible without exposing private error text or declaring connected', () => {
    const view = installed('synced')
    show({ ...view, record: { ...view.record!, error: 'secret provider diagnostic' } })
    expect(screen.getByRole('alert').textContent).toContain('Couldn’t complete')
    expect(screen.getByRole('status').textContent).toContain('Needs attention')
    expect(screen.queryByText('secret provider diagnostic')).toBeNull()
  })

  it('retains keyboard focus when the completed action disappears', () => {
    const ui = show(installed())
    screen.getByRole('button', { name: 'Configure Notes' }).focus()
    const view = installed('synced')
    ui.rerender(<IntegrationCard integration={{ ...view, record: { ...view.record!, actions: [] } }} locale="en" pending={false} error={false} {...ui} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /More actions/ }))
  })

  it('validates fields and submits credentials as an opaque payload, clearing inputs on close', async () => {
    const ui = show(configured)
    fireEvent.click(screen.getByRole('button', { name: 'Configure Notes' }))
    await screen.findByRole('dialog', { name: 'Configure Notes' })
    expect(screen.getByLabelText(/SecretKey/).getAttribute('type')).toBe('password')
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }))
    expect(ui.onAction).not.toHaveBeenCalled()
    expect(screen.getAllByText('Complete this field.')).toHaveLength(2)
    fireEvent.change(screen.getByLabelText(/AccessKey/), { target: { value: 'example-key' } })
    fireEvent.change(screen.getByLabelText(/SecretKey/), { target: { value: 'example-secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(ui.onAction).toHaveBeenCalledWith('configure', { accessKey: 'example-key', secretKey: 'example-secret' })
    fireEvent.click(screen.getByRole('button', { name: 'Configure Notes' }))
    await screen.findByRole('dialog')
    expect((screen.getByLabelText(/SecretKey/) as HTMLInputElement).value).toBe('')
  })

  it('prevents duplicate submissions and reports failures without retaining secrets', async () => {
    const ui = show(configured)
    let reject!: (error: Error) => void
    ui.onAction.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail }))
    fireEvent.click(screen.getByRole('button', { name: 'Configure Notes' }))
    await screen.findByRole('dialog')
    fireEvent.change(screen.getByLabelText(/AccessKey/), { target: { value: 'key' } })
    fireEvent.change(screen.getByLabelText(/SecretKey/), { target: { value: 'secret' } })
    const form = screen.getByRole('button', { name: 'Save and continue' }).closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(ui.onAction).toHaveBeenCalledOnce()
    reject(new Error('private secret'))
    expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t complete')
    expect((screen.getByLabelText(/SecretKey/) as HTMLInputElement).value).toBe('')
    expect(screen.queryByText('private secret')).toBeNull()
  })

  it('rejects an open form after its action becomes unavailable', async () => {
    const ui = show(configured)
    fireEvent.click(screen.getByRole('button', { name: 'Configure Notes' }))
    await screen.findByRole('dialog')
    ui.rerender(<IntegrationCard integration={{ ...configured, record: { ...configured.record!, actions: [] } }} locale="en" pending={false} error={false} {...ui} />)
    expect(screen.getByRole('alert').textContent).toContain('no longer available')
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }))
    expect(ui.onAction).not.toHaveBeenCalled()
  })
})
