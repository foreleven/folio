import { VaultRuntime } from '../services/vault-runtime'
import { VaultContext, makeVaultContext } from '../services/vault-context'
import { VaultWindowContexts } from '../services/vault-window-contexts'
import { TaskService } from '../services/task-service'
import { Context, Effect, Layer, ManagedRuntime } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MainWindow } from './MainWindow'

const windowLayer = MainWindow.layer.pipe(
  Layer.provide(
    Layer.succeed(VaultRuntime)({
      withClosed: (_id, operation) => operation,
      open: (id) =>
        Effect.succeed(Context.make(VaultContext, makeVaultContext({ id, name: 'wiki', path: '/wiki' }, '/config')).pipe(Context.add(TaskService, {} as TaskService['Service'])))
    })
  ),
  Layer.provide(VaultWindowContexts.layer)
)

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
    nativeTheme: { shouldUseDarkColors: true },
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
    const runtime = ManagedRuntime.make(windowLayer)
    const mainWindow = await runtime.runPromise(MainWindow)

    await runtime.runPromise(mainWindow.open)

    await expect(runtime.runPromise(mainWindow.isOpen)).resolves.toBe(true)
    expect(electronMocks.loadURL).toHaveBeenCalledWith('http://localhost:5173')
    expect(electronMocks.openDevTools).toHaveBeenCalledOnce()
    expect(electronMocks.createBrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        backgroundColor: '#0a0a0a',
        ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 12 } } : {}),
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
    const runtime = ManagedRuntime.make(windowLayer)
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
    const runtime = ManagedRuntime.make(windowLayer)
    const mainWindow = await runtime.runPromise(MainWindow)

    const error = await runtime.runPromise(Effect.flip(mainWindow.open))

    expect(error).toMatchObject({
      _tag: 'RendererLoadError',
      cause: loadError
    })
    await expect(runtime.runPromise(mainWindow.isOpen)).resolves.toBe(false)
    expect(electronMocks.destroy).toHaveBeenCalledOnce()
    await runtime.dispose()
    expect(electronMocks.destroy).toHaveBeenCalledOnce()
  })
})
