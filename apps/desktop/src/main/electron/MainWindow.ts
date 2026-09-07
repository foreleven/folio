import type { BrowserWindow } from 'electron'
import { Context, Effect, Layer } from 'effect'
import { createRendererWindow, loadRenderer, type RendererLoadError } from './renderer-window'

/** Main-window boundary owned by the Electron application program. */
export class MainWindow extends Context.Service<
  MainWindow,
  {
    /** Opens a renderer window. */
    readonly open: Effect.Effect<void, RendererLoadError>
    /** Reports whether an application window is currently open. */
    readonly isOpen: Effect.Effect<boolean>
  }
>()('folio/main/electron/MainWindow') {
  /** Live layer whose scope owns every window opened by the application. */
  static readonly layer = Layer.effect(
    MainWindow,
    Effect.gen(function*() {
      const windows = new Set<BrowserWindow>()

      /** Removes and destroys one window without double-closing it. */
      const destroyWindow = (window: BrowserWindow): void => {
        windows.delete(window)
        if (!window.isDestroyed()) {
          window.destroy()
        }
      }

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const window of Array.from(windows)) {
            destroyWindow(window)
          }
        })
      )

      const open = Effect.gen(function*() {
        const window = createRendererWindow()
        windows.add(window)
        window.once('closed', () => windows.delete(window))
        yield* loadRenderer(window).pipe(
          Effect.tapError(() => Effect.sync(() => destroyWindow(window)))
        )
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
