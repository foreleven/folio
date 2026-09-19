import { Effect, Layer, ManagedRuntime, Stream } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VaultLauncher } from './VaultLauncher'
import { VaultRuntime } from '../services/vault/vault-runtime'
import { VaultService } from '../services/vault/vault-service'
import { MainWindow } from './MainWindow'
import { HarnessStoreError } from '../../shared/harness'
import { VaultError } from '../../shared/vault'
import { RendererLoadError } from './renderer-window'
import { ConfigService } from '../services/config/config-service'
import { ConfigStoreError, type GlobalConfig } from '../../shared/config'

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
function runtime(
  register: Effect.Effect<typeof vault, VaultError> = Effect.succeed(vault),
  open: Effect.Effect<void, RendererLoadError> = Effect.void,
  get: Effect.Effect<GlobalConfig, ConfigStoreError> = Effect.succeed({
    theme: 'system',
    language: 'system',
    vaults: [vault],
    agent: { enabled: false, modelProfiles: [] }
  }),
  stop: Effect.Effect<void, HarnessStoreError> = Effect.void
) {
  const save = vi.fn(() => register)
  const launch = vi.fn(() => open)
  const close = vi.fn(() => Effect.void)
  const remove = vi.fn(() => Effect.void)
  const removeRegistration = vi.fn(() => Effect.succeed(vault))
  const instance = ManagedRuntime.make(VaultLauncher.layer.pipe(Layer.provide(Layer.mergeAll(
    Layer.succeed(ConfigService)({ directory: '/config', filePath: '/config/config.json', get, watch: Stream.empty, update: () => get, setAgent: () => get, addVault: (entry) => Effect.succeed(entry), removeVault: removeRegistration }),
    Layer.succeed(VaultService)({ register: save, remove }),
    Layer.succeed(VaultRuntime)({ open: () => Effect.die('Unexpected runtime open'), withClosed: (_id, operation) => stop.pipe(Effect.andThen(operation)) }),
    Layer.succeed(MainWindow)({ open: Effect.void, isOpen: Effect.succeed(false), openVault: launch, closeVault: close, getVault: () => Effect.succeed(null) })
  ))))
  return { instance, save, launch, close, remove, removeRegistration }
}

describe('VaultLauncher', () => {
  it('retains files and registration when background cleanup fails', async () => {
    const { instance, remove, removeRegistration } = runtime(undefined, undefined, undefined,
      Effect.fail(new HarnessStoreError({ reason: 'task-busy', message: 'process retained' })))
    try {
      const launcher = await instance.runPromise(VaultLauncher)
      expect(await instance.runPromise(launcher.remove(vault.id).pipe(Effect.flip))).toMatchObject({ _tag: 'VaultError', cause: { reason: 'task-busy' } })
      expect(remove).not.toHaveBeenCalled()
      expect(removeRegistration).not.toHaveBeenCalled()
    } finally { await instance.dispose() }
  })

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

  it('opens a registered vault by its saved path without showing a picker', async () => {
    const { instance, save, launch } = runtime()
    try {
      const service = await instance.runPromise(VaultLauncher)
      expect(await instance.runPromise(service.openExisting(vault.id))).toEqual(vault)
      expect(mocks.select).not.toHaveBeenCalled()
      expect(save).toHaveBeenCalledWith(vault.path)
      expect(launch).toHaveBeenCalledWith(vault, mocks.parent.id)
    } finally { await instance.dispose() }
  })

  it('rejects an unknown ID without registering a directory or opening a window', async () => {
    const { instance, save, launch } = runtime()
    try {
      const service = await instance.runPromise(VaultLauncher)
      expect(await instance.runPromise(Effect.flip(service.openExisting('unknown')))).toMatchObject({ _tag: 'VaultError' })
      expect(save).not.toHaveBeenCalled()
      expect(launch).not.toHaveBeenCalled()
      expect(mocks.select).not.toHaveBeenCalled()
    } finally { await instance.dispose() }
  })

  it('keeps a missing folder failure retryable and never opens its window', async () => {
    const { instance, save, launch } = runtime(Effect.fail(new VaultError({ message: 'Missing folder', cause: 'ENOENT' })))
    try {
      const service = await instance.runPromise(VaultLauncher)
      expect(await instance.runPromise(Effect.flip(service.openExisting(vault.id)))).toMatchObject({ message: 'Missing folder' })
      expect(launch).not.toHaveBeenCalled()
      save.mockReturnValueOnce(Effect.succeed(vault))
      expect(await instance.runPromise(service.openExisting(vault.id))).toEqual(vault)
      expect(launch).toHaveBeenCalledOnce()
    } finally { await instance.dispose() }
  })

  it('reports an unreadable vault index through the vault error channel', async () => {
    const { instance, save, launch } = runtime(Effect.succeed(vault), Effect.void,
      Effect.fail(new ConfigStoreError({ path: '/config/config.json', operation: 'read', cause: 'EACCES' })))
    try {
      const service = await instance.runPromise(VaultLauncher)
      expect(await instance.runPromise(Effect.flip(service.openExisting(vault.id)))).toMatchObject({ _tag: 'VaultError', cause: { _tag: 'ConfigStoreError' } })
      expect(save).not.toHaveBeenCalled()
      expect(launch).not.toHaveBeenCalled()
    } finally { await instance.dispose() }
  })

  it('closes an open vault before removing its registration', async () => {
    const { instance, close, remove, removeRegistration } = runtime()
    try {
      const service = await instance.runPromise(VaultLauncher)
      await expect(instance.runPromise(service.remove(vault.id))).resolves.toEqual(vault)
      expect(close).toHaveBeenCalledWith(vault.id)
      expect(remove).toHaveBeenCalledWith(vault)
      expect(removeRegistration).toHaveBeenCalledWith(vault.id)
      expect(close.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0])
      expect(remove.mock.invocationCallOrder[0]).toBeLessThan(removeRegistration.mock.invocationCallOrder[0])
    } finally { await instance.dispose() }
  })

})
