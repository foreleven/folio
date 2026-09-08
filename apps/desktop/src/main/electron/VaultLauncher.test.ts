import { Effect, Layer, ManagedRuntime } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VaultLauncher } from './VaultLauncher'
import { VaultService } from '../services/vault-service'
import { MainWindow } from './MainWindow'
import { VaultError } from '../../shared/vault'
import { RendererLoadError } from './renderer-window'

const mocks = vi.hoisted(() => ({ parent: { id: 1, isDestroyed: () => false }, focused: vi.fn(), select: vi.fn() }))
vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: mocks.focused },
  dialog: { showOpenDialog: mocks.select }
}))
beforeEach(() => {
  vi.resetAllMocks()
  mocks.focused.mockReturnValue(mocks.parent)
})

const vault = { id: '407bc090-c297-4b3b-96bb-6ced8f64b89c', name: 'wiki', path: '/wiki' }

/** Wires the native action to controllable storage/window boundaries. */
function runtime(register = Effect.succeed(vault), open: Effect.Effect<void, RendererLoadError> = Effect.void) {
  const save = vi.fn(() => register)
  const launch = vi.fn(() => open)
  const instance = ManagedRuntime.make(VaultLauncher.layer.pipe(Layer.provide(Layer.merge(
    Layer.succeed(VaultService)({ register: save }),
    Layer.succeed(MainWindow)({ open: Effect.void, isOpen: Effect.succeed(false), openVault: launch, getVault: () => Effect.succeed(null) })
  ))))
  return { instance, save, launch }
}

describe('VaultLauncher', () => {
  it('parents the picker to the focused window and opens only the persisted vault', async () => {
    mocks.select.mockImplementationOnce(async () => {
      // Another window becomes focused before the folder picker resolves.
      mocks.focused.mockReturnValue({ id: 2, isDestroyed: () => false })
      return { canceled: false, filePaths: ['/selected'] }
    })
    const { instance, save, launch } = runtime()
    try {
      expect(await instance.runPromise(Effect.flatMap(VaultLauncher, (service) => service.open))).toEqual(vault)
      expect(mocks.select).toHaveBeenLastCalledWith(mocks.parent, expect.objectContaining({ properties: ['openDirectory', 'createDirectory'] }))
      expect(save).toHaveBeenCalledWith('/selected')
      expect(launch).toHaveBeenCalledWith(vault, mocks.parent.id)
    } finally { await instance.dispose() }
  })

  it.each([{ canceled: true, filePaths: ['/ignored'] }, { canceled: false, filePaths: [] }])(
    'does not register or open on cancellation or empty selection', async (result) => {
      mocks.select.mockResolvedValueOnce(result)
      const { instance, save, launch } = runtime()
      try {
        expect(await instance.runPromise(Effect.flatMap(VaultLauncher, (service) => service.open))).toBeNull()
        expect(save).not.toHaveBeenCalled()
        expect(launch).not.toHaveBeenCalled()
      } finally { await instance.dispose() }
    }
  )

  it('returns picker and window load failures through the typed RPC error channel', async () => {
    mocks.select.mockRejectedValueOnce(new Error('picker failed'))
    const { instance, save } = runtime(Effect.succeed(vault), Effect.fail(new RendererLoadError({ cause: 'load failed' })))
    try {
      const service = await instance.runPromise(VaultLauncher)
      expect(await instance.runPromise(Effect.flip(service.open))).toBeInstanceOf(VaultError)
      expect(save).not.toHaveBeenCalled()
      mocks.select.mockResolvedValueOnce({ canceled: false, filePaths: ['/wiki'] })
      expect(await instance.runPromise(Effect.flip(service.open))).toMatchObject({ _tag: 'VaultError', cause: { _tag: 'RendererLoadError' } })
    } finally { await instance.dispose() }
  })
})
