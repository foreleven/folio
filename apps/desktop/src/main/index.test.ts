import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  loadFile: vi.fn(),
  loadURL: vi.fn(),
  openDevTools: vi.fn(),
  registerIpcHandler: vi.fn(),
  onAppEvent: vi.fn(),
  onWebContentsEvent: vi.fn(),
  openExternal: vi.fn(),
  setWindowOpenHandler: vi.fn(),
  show: vi.fn(),
  once: vi.fn()
}))

vi.mock('electron', () => {
  const mainWindow = {
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
  const BrowserWindow = vi.fn(function BrowserWindowMock() {
    return mainWindow
  })
  Object.assign(BrowserWindow, { getAllWindows: () => [mainWindow] })

  return {
    app: {
      getVersion: () => '0.1.0',
      on: electronMocks.onAppEvent,
      quit: vi.fn(),
      whenReady: () => Promise.resolve()
    },
    BrowserWindow,
    ipcMain: { handle: electronMocks.registerIpcHandler },
    shell: { openExternal: electronMocks.openExternal }
  }
})

/** Loads the main entry and waits for its ready callback to create the window. */
async function loadMain(): Promise<void> {
  vi.resetModules()
  await import('./index')
  await Promise.resolve()
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('desktop main window', () => {
  it('opens DevTools when loading the development renderer', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')

    await loadMain()

    expect(electronMocks.loadURL).toHaveBeenCalledWith('http://localhost:5173')
    expect(electronMocks.openDevTools).toHaveBeenCalledOnce()
  })

  it('keeps DevTools closed when loading the packaged renderer', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '')

    await loadMain()

    expect(electronMocks.loadFile).toHaveBeenCalledOnce()
    expect(electronMocks.openDevTools).not.toHaveBeenCalled()
  })
})
