// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSettings } from './AgentSettings'

const state = vi.hoisted(() => ({
  modelsAtom: {}, catalogAtom: {},
  models: { _tag: 'Initial' } as any,
  catalog: { _tag: 'Initial' } as any,
  locale: 'en' as 'en' | 'zh-CN',
  refreshModels: vi.fn(), refreshCatalog: vi.fn(), refreshQuery: vi.fn(), setCredential: vi.fn()
}))
vi.mock('@effect/atom-react', () => ({
  useAtomValue: (atom: unknown) => atom === state.modelsAtom ? state.models : state.catalog,
  useAtomRefresh: (atom: unknown) => atom === state.modelsAtom ? state.refreshModels : state.refreshQuery,
  useAtomSet: () => state.refreshCatalog
}))
vi.mock('../preferences', () => ({ useLocale: () => state.locale }))
vi.mock('../rpc/model-rpc', () => ({ modelsAtom: state.modelsAtom, modelCatalogAtom: state.catalogAtom, ModelRpcClient: { refreshCatalog: {} } }))
vi.mock('./models/use-set-provider-credential', () => ({ useSetProviderCredential: () => state.setCredential }))

const entry = (providerId: string, providerName: string, modelName: string) => ({
  providerId, providerName, modelId: `${providerId}-model`, modelName,
  api: 'openai-completions', source: 'builtin', reasoning: true, input: ['text'], contextWindow: 128000, maxTokens: 4096
})

beforeEach(() => {
  state.locale = 'en'
  state.models = { _tag: 'Success', value: { enabled: false, profiles: [], configuredProviders: ['anthropic'] } }
  state.catalog = { _tag: 'Success', value: { stale: false, models: [entry('anthropic', 'Anthropic', 'Claude'), entry('openrouter', 'OpenRouter', 'Router model')] } }
  state.setCredential.mockReset().mockResolvedValue(undefined)
  state.refreshModels.mockReset()
  state.refreshCatalog.mockReset().mockResolvedValue(undefined)
  state.refreshQuery.mockReset()
})
afterEach(cleanup)

/** Opens the setup surface as a user would, keeping assertions scoped to its dialog. */
function openDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'Add provider' }))
  return within(screen.getByRole('dialog'))
}

describe('Agent provider settings', () => {
  it('selects Pi by default and shows the configured provider models without profile controls', () => {
    render(<AgentSettings />)
    expect(screen.getByRole('button', { name: 'Pi' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: /Codex/ }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Claude')).toBeTruthy()
    expect(screen.queryByText('Router model')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Choose model' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Set as default' })).toBeNull()
  })

  it('offers only provider and key inputs, updating the read-only model list on selection', () => {
    render(<AgentSettings />)
    const dialog = openDialog()
    expect(dialog.getAllByRole('combobox')).toHaveLength(1)
    expect(dialog.queryByLabelText('Profile name')).toBeNull()
    expect(dialog.queryByLabelText('Thinking level')).toBeNull()
    fireEvent.change(dialog.getByLabelText('Provider name'), { target: { value: 'openrouter' } })
    expect(dialog.getByText('Router model')).toBeTruthy()
    expect(dialog.queryByText('Claude')).toBeNull()
    fireEvent.change(dialog.getByLabelText('API key'), { target: { value: 'draft-secret' } })
    fireEvent.change(dialog.getByLabelText('Provider name'), { target: { value: 'anthropic' } })
    expect((dialog.getByLabelText('API key') as HTMLInputElement).value).toBe('')
    expect(dialog.getByText('Claude')).toBeTruthy()
  })

  it('validates required values and submits provider/key exactly once without a model', async () => {
    let finish!: () => void
    state.setCredential.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    render(<AgentSettings />)
    const dialog = openDialog()
    fireEvent.click(dialog.getByRole('button', { name: 'Add provider' }))
    expect(dialog.getByRole('alert').textContent).toBe('Complete this field.')
    expect(state.setCredential).not.toHaveBeenCalled()
    fireEvent.change(dialog.getByLabelText('Provider name'), { target: { value: 'openrouter' } })
    fireEvent.change(dialog.getByLabelText('API key'), { target: { value: ' test-secret ' } })
    const form = dialog.getByRole('button', { name: 'Add provider' }).closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(state.setCredential).toHaveBeenCalledExactlyOnceWith('openrouter', 'test-secret')
    state.models.value.configuredProviders.push('openrouter')
    await act(async () => { finish() })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByText('Router model')).toBeTruthy()
    expect(state.refreshModels).toHaveBeenCalledOnce()
  })

  it('clears failed secrets, hides raw errors, and discards the draft on cancel', async () => {
    state.setCredential.mockRejectedValue(new Error('private-provider-response'))
    render(<AgentSettings />)
    let dialog = openDialog()
    fireEvent.change(dialog.getByLabelText('Provider name'), { target: { value: 'anthropic' } })
    fireEvent.change(dialog.getByLabelText('API key'), { target: { value: 'secret' } })
    await act(async () => { fireEvent.click(dialog.getByRole('button', { name: 'Add provider' })) })
    expect(dialog.getByRole('alert').textContent).toBe('Couldn’t update the credential.')
    expect((dialog.getByLabelText('API key') as HTMLInputElement).value).toBe('')
    expect(screen.queryByText('private-provider-response')).toBeNull()
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }))
    dialog = openDialog()
    expect((dialog.getByLabelText('API key') as HTMLInputElement).value).toBe('')
  })

  it('handles loading, retry and an empty provider list', () => {
    state.models = { _tag: 'Initial' }
    const ui = render(<AgentSettings />)
    expect(screen.getByRole('status', { name: 'Loading model settings…' })).toBeTruthy()
    state.models = { _tag: 'Failure' }
    ui.rerender(<AgentSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(state.refreshModels).toHaveBeenCalledOnce()
    state.models = { _tag: 'Success', value: { profiles: [], configuredProviders: [] } }
    ui.rerender(<AgentSettings />)
    expect(screen.getByText('Add a provider to see its models.')).toBeTruthy()
  })

  it('retains cached models when refresh fails and displays localized provider setup', async () => {
    state.refreshCatalog.mockRejectedValue(new Error('private-error'))
    render(<AgentSettings />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh catalog' })) })
    expect(screen.getByText('Claude')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Cached models remain available.')
    cleanup()
    state.locale = 'zh-CN'
    render(<AgentSettings />)
    fireEvent.click(screen.getByRole('button', { name: '添加 Provider' }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByLabelText('Provider 名称')).toBeTruthy()
    expect(dialog.getByLabelText('API Key')).toBeTruthy()
  })
})
