import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ELECTRON_RPC_REQUEST_CHANNEL } from '../shared/rpc/electron-rpc'
// Electron's asset transform belongs to the bundler; lifecycle tests use an inert archive path.
vi.mock('../../../../packages/integrations/src/lark/assets/lark-cli-1.0.94-darwin-arm64.tar.gz?asset&asarUnpack', () => ({ default: '/test/lark-cli.tar.gz' }))


const electronMocks = vi.hoisted(() => ({
  appListeners: new Map<string, () => void>(),
  createBrowserWindow: vi.fn(),
  destroyWindow: vi.fn(),
  isWindowDestroyed: vi.fn(() => false),
  loadFile: vi.fn(() => Promise.resolve()),
  loadURL: vi.fn(() => Promise.resolve()),
  openDevTools: vi.fn(),
  registerIpcListener: vi.fn(),
  removeAppListener: vi.fn((event: string) => {
    electronMocks.appListeners.delete(event)
  }),
  removeIpcListener: vi.fn(),
  onAppEvent: vi.fn((event: string, listener: () => void) => {
    electronMocks.appListeners.set(event, listener)
  }),
  onWebContentsEvent: vi.fn(),
  openExternal: vi.fn(),
  setWindowOpenHandler: vi.fn(),
  show: vi.fn(),
  once: vi.fn()
}))

vi.mock('electron', () => {
  const mainWindow = {
    destroy: electronMocks.destroyWindow,
    isDestroyed: electronMocks.isWindowDestroyed,
    loadFile: electronMocks.loadFile,
    loadURL: electronMocks.loadURL,
    once: electronMocks.once,
    show: electronMocks.show,
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
  Object.assign(BrowserWindow, { getAllWindows: () => [] })

  return {
    nativeTheme: {
      themeSource: 'system',
      shouldUseDarkColors: false,
      on: vi.fn(),
      removeListener: vi.fn()
    },
    Menu: {
      getApplicationMenu: () => null,
      buildFromTemplate: vi.fn((template) => template),
      setApplicationMenu: vi.fn()
    },
    app: {
      getAppPath: () => '/test/folio',
      getVersion: () => '0.1.0',
      isPackaged: false,
      on: electronMocks.onAppEvent,
      quit: vi.fn(),
      removeListener: electronMocks.removeAppListener,
      whenReady: () => Promise.resolve()
    },
    BrowserWindow,
    ipcMain: {
      on: electronMocks.registerIpcListener,
      removeListener: electronMocks.removeIpcListener
    },
    shell: { openExternal: electronMocks.openExternal }
  }
})

/** Loads the main entry and waits for its ready callback to create the window. */
async function loadMain(): Promise<void> {
  vi.resetModules()
  await import('./index')
  await vi.waitFor(() => expect(electronMocks.createBrowserWindow).toHaveBeenCalledOnce())
}

/** Completes the running program through Electron's normal shutdown event. */
async function shutdownMain(): Promise<void> {
  await vi.waitFor(() =>
    expect(electronMocks.appListeners.has('before-quit')).toBe(true)
  )
  electronMocks.appListeners.get('before-quit')?.()
  await vi.waitFor(() =>
    expect(electronMocks.removeIpcListener).toHaveBeenCalledOnce()
  )
}

let configDirectory: string

beforeEach(async () => {
  configDirectory = await mkdtemp(join(tmpdir(), 'folio-main-test-'))
  vi.stubEnv('FOLIO_CONFIG_DIR', configDirectory)
  electronMocks.appListeners.clear()
  vi.clearAllMocks()
  electronMocks.isWindowDestroyed.mockReturnValue(false)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(configDirectory, { recursive: true, force: true })
})

describe('desktop main window', () => {
  it('opens DevTools when loading the development renderer', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')

    await loadMain()

    expect(electronMocks.loadURL).toHaveBeenCalledWith('http://localhost:5173')
    expect(electronMocks.openDevTools).toHaveBeenCalledOnce()
    await vi.waitFor(() =>
      expect(electronMocks.registerIpcListener).toHaveBeenCalledWith(
        ELECTRON_RPC_REQUEST_CHANNEL,
        expect.any(Function)
      )
    )
    expect(electronMocks.createBrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        webPreferences: expect.objectContaining({
          preload: expect.stringMatching(/index\.cjs$/)
        })
      })
    )
    await shutdownMain()
    expect(electronMocks.destroyWindow).toHaveBeenCalledOnce()
    expect(electronMocks.removeAppListener).toHaveBeenCalledTimes(3)
  })

  it('keeps DevTools closed when loading the packaged renderer', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '')

    await loadMain()

    expect(electronMocks.loadFile).toHaveBeenCalledOnce()
    expect(electronMocks.openDevTools).not.toHaveBeenCalled()
    await shutdownMain()
  })
})
