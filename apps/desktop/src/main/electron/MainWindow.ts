import { BrowserWindow, shell } from 'electron'
import { Context, Effect, Layer } from 'effect'
import { join } from 'node:path'

/**
 * Opens a renderer-provided URL only when it uses a web protocol. Invalid and
 * custom-scheme URLs stay blocked from operating-system protocol handlers.
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

/** Creates and configures one isolated renderer window. */
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

/** Main-window boundary owned by the Electron application program. */
export class MainWindow extends Context.Service<
  MainWindow,
  {
    /** Opens a renderer window. */
    readonly open: Effect.Effect<void>
    /** Reports whether an application window is currently open. */
    readonly isOpen: Effect.Effect<boolean>
  }
>()('folio/main/electron/MainWindow') {
  /** Live layer whose scope owns every window opened by the application. */
  static readonly layer = Layer.effect(
    MainWindow,
    Effect.gen(function*() {
      const windows = new Set<BrowserWindow>()

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const window of windows) {
            if (!window.isDestroyed()) {
              window.destroy()
            }
          }
          windows.clear()
        })
      )

      const open = Effect.sync(() => {
        const window = createWindow()
        windows.add(window)
        window.once('closed', () => windows.delete(window))
      })

      return MainWindow.of({
        open,
        isOpen: Effect.sync(() =>
          Array.from(windows).some((window) => !window.isDestroyed())
        )
      })
    })
  )
}
