import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { Context, Effect, Layer, ManagedRuntime } from 'effect'
import { MainRpcLive } from './rpc/runtime'

/** Effect service for Electron's process-level application resource. */
class ElectronApp extends Context.Service<ElectronApp, typeof app>()(
  'folio/main/ElectronApp'
) {}

/** Effect service for the main window owned by the application scope. */
class MainBrowserWindow extends Context.Service<MainBrowserWindow, BrowserWindow>()(
  'folio/main/BrowserWindow'
) {}

const ElectronAppLive = Layer.succeed(ElectronApp)(app)

/** BrowserWindow resource Layer; construction starts only after Electron is ready. */
const MainBrowserWindowLive = Layer.effect(
  MainBrowserWindow,
  Effect.gen(function*() {
    const electronApp = yield* ElectronApp
    yield* Effect.promise(() => electronApp.whenReady())
    const mainWindow = yield* Effect.acquireRelease(
      Effect.sync(createWindow),
      (window) =>
        Effect.sync(() => {
          if (!window.isDestroyed()) {
            window.destroy()
          }
        })
    )

    const onActivate = () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    }
    const onWindowAllClosed = () => {
      if (process.platform !== 'darwin') {
        electronApp.quit()
      }
    }

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        electronApp.on('activate', onActivate)
        electronApp.on('window-all-closed', onWindowAllClosed)
      }),
      () =>
        Effect.sync(() => {
          electronApp.removeListener('activate', onActivate)
          electronApp.removeListener('window-all-closed', onWindowAllClosed)
        })
    )

    return mainWindow
  })
).pipe(Layer.provide(ElectronAppLive))

/** Complete main-process Layer: Electron resources plus the Effect RPC server. */
const MainLive = Layer.mergeAll(
  ElectronAppLive,
  MainBrowserWindowLive,
  MainRpcLive
)

/** Main-process application runtime; its scope owns every MainLive resource. */
const mainRuntime = ManagedRuntime.make(MainLive)

void mainRuntime.runPromise(
  Effect.gen(function*() {
    yield* ElectronApp
    yield* MainBrowserWindow
  })
).catch((error: unknown) => {
  console.error('Failed to start main Effect runtime', error)
})

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
function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
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
    // Development starts with diagnostics visible; packaged windows remain unaffected.
    mainWindow.webContents.openDevTools()
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

app.on('before-quit', () => {
  void mainRuntime.dispose()
})
