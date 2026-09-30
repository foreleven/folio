// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SystemOneSettings } from './SystemOneSettings'

const state = vi.hoisted(() => ({ settings: { _tag: 'Success', value: {} } as any, save: vi.fn() }))
vi.mock('@effect/atom-react', () => ({ useAtomValue: () => state.settings }))
vi.mock('../rpc/model-rpc', () => ({ modelsAtom: {} }))
vi.mock('../preferences', () => ({ useLocale: () => 'en' }))
vi.mock('./models/use-save-system-one', () => ({ useSaveSystemOne: () => state.save }))
beforeEach(() => { state.settings = { _tag: 'Success', value: {} }; state.save.mockReset().mockResolvedValue({}) })
afterEach(cleanup)

it('accepts a local HTTP endpoint, prevents duplicate submissions, and clears the submitted key', async () => {
  let complete!: () => void
  state.save.mockImplementation(() => new Promise<void>(resolve => { complete = resolve }))
  render(<SystemOneSettings />)
  expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
  fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'http://localhost:8000/v1' } })
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'local-jev' } })
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: ' one-shot-key ' } })
  const form = screen.getByRole('button', { name: 'Save' }).closest('form')!
  fireEvent.submit(form); fireEvent.submit(form)
  expect(state.save).toHaveBeenCalledExactlyOnceWith({ baseUrl: 'http://localhost:8000/v1', model: 'local-jev' }, 'one-shot-key')
  await act(async () => { complete() })
  expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('')
});

it('allows retaining an existing key and hides provider diagnostics on failure', async () => {
  state.settings.value.systemOne = { configuration: { baseUrl: 'http://localhost:8000/v1', model: 'jev' }, credentialConfigured: true }
  state.save.mockRejectedValue(new Error('private-provider-diagnostic'))
  render(<SystemOneSettings />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
  expect(state.save).toHaveBeenCalledExactlyOnceWith({ baseUrl: 'http://localhost:8000/v1', model: 'jev' }, '')
  expect(screen.getByRole('alert').textContent).toBe('Could not save System One settings')
  expect(screen.queryByText('private-provider-diagnostic')).toBeNull()
});
