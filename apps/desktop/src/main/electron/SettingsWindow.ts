import type { BrowserWindow } from 'electron'
import { Context, Effect, Layer, Semaphore } from 'effect'
import { createRendererWindow, loadRenderer, type RendererLoadError } from './renderer-window'

/** Owns one independent settings window for the lifetime of the main runtime. */
export class SettingsWindow extends Context.Service<SettingsWindow, {
  /** Opens settings when absent, or closes the existing window; serializes repeated requests. */
  readonly toggle: Effect.Effect<void, RendererLoadError>
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

    const toggle = Effect.gen(function*() {
      if (window && !window.isDestroyed()) {
        const current = window
        // Wait for native close completion before the next queued toggle can reopen it.
        yield* Effect.callback<void>((resume) => {
          const onClosed = () => resume(Effect.void)
          current.once('closed', onClosed)
          current.close()
          return Effect.sync(() => current.removeListener('closed', onClosed))
        })
        return
      }

      const current = createRendererWindow({
        title: 'Settings — Folio',
        width: 960,
        height: 720,
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

    return SettingsWindow.of({ toggle })
  }))
}
