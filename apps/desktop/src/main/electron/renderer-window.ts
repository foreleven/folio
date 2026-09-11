import { BrowserWindow, nativeTheme, shell, type BrowserWindowConstructorOptions } from 'electron'
import { Effect, Schema } from 'effect'
import { join } from 'node:path'

/** Renderer navigation failed while opening an application window. */
export class RendererLoadError extends Schema.TaggedError<RendererLoadError>()('RendererLoadError', { cause: Schema.Defect() }) {}

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

/** Matches the shared UI's background token for the current effective Electron theme. */
export function getRendererBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff'
}

/** Creates and configures one isolated renderer window with a matching native background. */
export function createRendererWindow(options: BrowserWindowConstructorOptions = {}): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    show: false,
    backgroundColor: getRendererBackgroundColor(),
    // Keep macOS traffic lights while letting the renderer own the titlebar surface.
    // Other platforms retain their native window controls and frame.
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 14, y: 12 }
        }
      : {}),
    ...options,
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

  return mainWindow
}

/** Loads the configured renderer and keeps navigation failures in Effect. */
export function loadRenderer(mainWindow: BrowserWindow, page?: 'settings' | `vault/${string}`): Effect.Effect<void, RendererLoadError> {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL

  if (rendererUrl && !page) {
    // Development starts with diagnostics visible; packaged windows remain unaffected.
    mainWindow.webContents.openDevTools()
  }

  return Effect.tryPromise({
    try: () =>
      rendererUrl
        ? mainWindow.loadURL(page ? `${rendererUrl.replace(/#.*$/, '')}#${page}` : rendererUrl)
        : mainWindow.loadFile(join(__dirname, '../renderer/index.html'), page ? { hash: page } : undefined),
    catch: (cause) => new RendererLoadError({ cause })
  })
}
