import type { BrowserWindow } from 'electron'
import { Context, Effect, Layer, Semaphore } from 'effect'
import { createRendererWindow, loadRenderer, type RendererLoadError } from './renderer-window'

/** Owns one independent settings window for the lifetime of the main runtime. */
export class SettingsWindow extends Context.Service<SettingsWindow, {
  /** Opens settings, or restores and focuses the existing window; load failures allow retry. */
  readonly open: Effect.Effect<void, RendererLoadError>
}>()('folio/main/electron/SettingsWindow') {
  static readonly layer = Layer.effect(SettingsWindow, Effect.gen(function*() {
    let window: BrowserWindow | undefined
    const lock = yield* Semaphore.make(1)

    /** Releases the tracked window on runtime shutdown or failed renderer loading. */
    const destroy = (): void => {
      const current = window
      window = undefined
      if (current && !current.isDestroyed()) current.destroy()
    }
    yield* Effect.addFinalizer(() => Effect.sync(destroy))

    const open = Effect.gen(function*() {
      if (window && !window.isDestroyed()) {
        if (window.isMinimized()) window.restore()
        window.show()
        window.focus()
        return
      }

      const current = createRendererWindow({
        title: 'Settings — Folio',
        width: 680,
        height: 520,
        minWidth: 560,
        minHeight: 440,
        maximizable: false,
        fullscreenable: false
      })
      window = current
      current.once('closed', () => {
        if (window === current) window = undefined
      })
      yield* loadRenderer(current, 'settings').pipe(
        Effect.onError(() => Effect.sync(destroy))
      )
    }).pipe(lock.withPermit)

    return SettingsWindow.of({ open })
  }))
}
