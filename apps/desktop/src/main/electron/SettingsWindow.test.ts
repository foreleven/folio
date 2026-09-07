import { Effect, ManagedRuntime } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { SettingsWindow } from './SettingsWindow'

const mocks = vi.hoisted(() => ({
  create: vi.fn(), destroy: vi.fn(), close: vi.fn(), show: vi.fn(),
  isDestroyed: vi.fn(() => false),
  loadURL: vi.fn(() => Promise.resolve()), loadFile: vi.fn(() => Promise.resolve()),
  once: vi.fn(), on: vi.fn(), setWindowOpenHandler: vi.fn()
}))

vi.mock('electron', () => ({
  nativeTheme: { shouldUseDarkColors: true },
  BrowserWindow: vi.fn(function(options: unknown) {
    mocks.create(options)
    const events = new EventEmitter()
    return {
      ...mocks,
      once: (event: string, listener: () => void) => {
        mocks.once(event, listener)
        events.once(event, listener)
      },
      removeListener: (event: string, listener: () => void) => events.removeListener(event, listener),
      // Native close completes asynchronously; toggles must wait for this event.
      close: () => {
        mocks.close()
        queueMicrotask(() => events.emit('closed'))
      },
      webContents: { on: mocks.on, setWindowOpenHandler: mocks.setWindowOpenHandler }
    }
  }),
  shell: { openExternal: vi.fn() }
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isDestroyed.mockReturnValue(false)
})
afterEach(() => vi.unstubAllEnvs())

describe('SettingsWindow', () => {
  it('serializes opening, closing, and reopening settings on repeated requests', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
    const runtime = ManagedRuntime.make(SettingsWindow.layer)
    try {
      const settings = await runtime.runPromise(SettingsWindow)
      await runtime.runPromise(Effect.all([settings.toggle, settings.toggle], { concurrency: 'unbounded' }))
      expect(mocks.create).toHaveBeenCalledOnce()
      expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Settings — Folio',
        backgroundColor: '#0a0a0a',
        webPreferences: expect.objectContaining({ contextIsolation: true, sandbox: true })
      }))
      expect(mocks.loadURL).toHaveBeenCalledWith('http://localhost:5173#settings')
      expect(mocks.close).toHaveBeenCalledOnce()
      expect(mocks.destroy).not.toHaveBeenCalled()
      await runtime.runPromise(settings.toggle)
      expect(mocks.create).toHaveBeenCalledTimes(2)
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
      await runtime.runPromise(settings.toggle)
      expect(mocks.loadFile).toHaveBeenCalledWith(expect.stringMatching(/renderer\/index.html$/), { hash: 'settings' })
      const onClosed = mocks.once.mock.calls.find(([event]) => event === 'closed')?.[1]
      onClosed()
      await runtime.runPromise(settings.toggle)
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
      expect(await runtime.runPromise(Effect.flip(settings.toggle))).toMatchObject({ _tag: 'RendererLoadError' })
      expect(mocks.destroy).toHaveBeenCalledOnce()
      await runtime.runPromise(settings.toggle)
      expect(mocks.create).toHaveBeenCalledTimes(2)
    } finally {
      await runtime.dispose()
    }
  })
})
