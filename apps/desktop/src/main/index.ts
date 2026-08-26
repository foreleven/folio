import 'reflect-metadata'
import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { createRpcContainer, getRpcServer } from './rpc/container'
import { registerElectronRpc } from './rpc/electron-rpc'

const rpcContainer = createRpcContainer()
registerElectronRpc(getRpcServer(rpcContainer))

/**
 * Opens a renderer-provided URL only when it uses a web protocol. Invalid and
 * custom-scheme URLs stay blocked so renderer content cannot invoke arbitrary
 * protocol handlers registered with the operating system.
 */
function openExternalUrl(rawUrl: string): void {
  try {
    const url = new URL(rawUrl)

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return
    }

    void shell.openExternal(url.toString()).catch((error: unknown) => {
      console.error('Failed to open external URL', error)
    })
  } catch {
    // Malformed URLs are intentionally ignored at this process boundary.
  }
}

/**
 * Creates the single application window and loads the development server or
 * packaged renderer. External links are delegated to the user's browser so
 * untrusted pages never gain access to the Electron renderer context.
 */
function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: true
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    openExternalUrl(url)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
