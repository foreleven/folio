import { Effect, ManagedRuntime } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsWindow } from './SettingsWindow'

const mocks = vi.hoisted(() => ({
  create: vi.fn(), destroy: vi.fn(), focus: vi.fn(), show: vi.fn(), restore: vi.fn(),
  isDestroyed: vi.fn(() => false), isMinimized: vi.fn(() => false),
  loadURL: vi.fn(() => Promise.resolve()), loadFile: vi.fn(() => Promise.resolve()),
  once: vi.fn(), on: vi.fn(), setWindowOpenHandler: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(function(options: unknown) {
    mocks.create(options)
    return { ...mocks, webContents: { on: mocks.on, setWindowOpenHandler: mocks.setWindowOpenHandler } }
  }),
  shell: { openExternal: vi.fn() }
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isDestroyed.mockReturnValue(false)
  mocks.isMinimized.mockReturnValue(false)
})
afterEach(() => vi.unstubAllEnvs())

describe('SettingsWindow', () => {
  it('opens one sandboxed settings window, restoring and focusing it on repeated requests', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
    const runtime = ManagedRuntime.make(SettingsWindow.layer)
    try {
      const settings = await runtime.runPromise(SettingsWindow)
      await runtime.runPromise(Effect.all([settings.open, settings.open], { concurrency: 'unbounded' }))
      expect(mocks.create).toHaveBeenCalledOnce()
      expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Settings — Folio',
        webPreferences: expect.objectContaining({ contextIsolation: true, sandbox: true })
      }))
      expect(mocks.loadURL).toHaveBeenCalledWith('http://localhost:5173#settings')
      expect(mocks.focus).toHaveBeenCalledOnce()
      mocks.isMinimized.mockReturnValue(true)
      await runtime.runPromise(settings.open)
      expect(mocks.restore).toHaveBeenCalledOnce()
    } finally {
      await runtime.dispose()
    }
    expect(mocks.destroy).toHaveBeenCalledOnce()
  })

  it('loads packaged settings and creates a new window after close', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '')
    const runtime = ManagedRuntime.make(SettingsWindow.layer)
    try {
      const settings = await runtime.runPromise(SettingsWindow)
      await runtime.runPromise(settings.open)
      expect(mocks.loadFile).toHaveBeenCalledWith(expect.stringMatching(/renderer\/index.html$/), { hash: 'settings' })
      const onClosed = mocks.once.mock.calls.find(([event]) => event === 'closed')?.[1]
      onClosed()
      await runtime.runPromise(settings.open)
      expect(mocks.create).toHaveBeenCalledTimes(2)
    } finally {
      await runtime.dispose()
    }
  })

  it('destroys a failed window and allows the next open to retry', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
    mocks.loadURL.mockRejectedValueOnce(new Error('unavailable'))
    const runtime = ManagedRuntime.make(SettingsWindow.layer)
    try {
      const settings = await runtime.runPromise(SettingsWindow)
      expect(await runtime.runPromise(Effect.flip(settings.open))).toMatchObject({ _tag: 'RendererLoadError' })
      expect(mocks.destroy).toHaveBeenCalledOnce()
      await runtime.runPromise(settings.open)
      expect(mocks.create).toHaveBeenCalledTimes(2)
    } finally {
      await runtime.dispose()
    }
  })
})
