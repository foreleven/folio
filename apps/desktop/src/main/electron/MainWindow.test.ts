import { Effect, ManagedRuntime } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MainWindow } from './MainWindow'

const electronMocks = vi.hoisted(() => ({
  createBrowserWindow: vi.fn(),
  destroy: vi.fn(),
  isDestroyed: vi.fn(() => false),
  loadFile: vi.fn(() => Promise.resolve()),
  loadURL: vi.fn(() => Promise.resolve()),
  onWebContentsEvent: vi.fn(),
  openDevTools: vi.fn(),
  openExternal: vi.fn(() => Promise.resolve()),
  setWindowOpenHandler: vi.fn(),
  show: vi.fn(),
  once: vi.fn()
}))

vi.mock('electron', () => {
  const mainWindow = {
    destroy: electronMocks.destroy,
    isDestroyed: electronMocks.isDestroyed,
    loadFile: electronMocks.loadFile,
    loadURL: electronMocks.loadURL,
    once: electronMocks.once,
    webContents: {
      on: electronMocks.onWebContentsEvent,
      openDevTools: electronMocks.openDevTools,
      setWindowOpenHandler: electronMocks.setWindowOpenHandler
    }
  }
  const BrowserWindow = vi.fn(function BrowserWindowMock(options: unknown) {
    electronMocks.createBrowserWindow(options)
    return mainWindow
  })

  return {
    BrowserWindow,
    shell: { openExternal: electronMocks.openExternal }
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  electronMocks.isDestroyed.mockReturnValue(false)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('MainWindow live service', () => {
  it('owns the development renderer window for its runtime scope', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
    const runtime = ManagedRuntime.make(MainWindow.layer)
    const mainWindow = await runtime.runPromise(MainWindow)

    await runtime.runPromise(mainWindow.open)

    await expect(runtime.runPromise(mainWindow.isOpen)).resolves.toBe(true)
    expect(electronMocks.loadURL).toHaveBeenCalledWith('http://localhost:5173')
    expect(electronMocks.openDevTools).toHaveBeenCalledOnce()
    expect(electronMocks.createBrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        webPreferences: expect.objectContaining({
          preload: expect.stringMatching(/index\.cjs$/)
        })
      })
    )

    await runtime.dispose()
    expect(electronMocks.destroy).toHaveBeenCalledOnce()
  })

  it('keeps DevTools closed for the packaged renderer', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '')
    const runtime = ManagedRuntime.make(MainWindow.layer)
    const mainWindow = await runtime.runPromise(MainWindow)

    await runtime.runPromise(mainWindow.open)

    expect(electronMocks.loadFile).toHaveBeenCalledOnce()
    expect(electronMocks.openDevTools).not.toHaveBeenCalled()
    await runtime.dispose()
  })

  it('reports renderer load failures through the Effect error channel', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
    const loadError = new Error('renderer unavailable')
    electronMocks.loadURL.mockRejectedValueOnce(loadError)
    const runtime = ManagedRuntime.make(MainWindow.layer)
    const mainWindow = await runtime.runPromise(MainWindow)

    const error = await runtime.runPromise(Effect.flip(mainWindow.open))

    expect(error).toMatchObject({
      _tag: 'RendererLoadError',
      cause: loadError
    })
    await runtime.dispose()
  })
})
