import { BrowserWindow, nativeTheme } from 'electron'
import { Effect, Layer, Schedule, Stream } from 'effect'
import { ConfigService } from '../services/config/config-service'
import { getRendererBackgroundColor } from './renderer-window'

/** Applies persisted appearance before windows are created and keeps native surfaces in sync. */
export const ApplicationThemeLive = Layer.effectDiscard(Effect.gen(function*() {
  const config = yield* ConfigService
  const theme = yield* config.get.pipe(
    Effect.map((value) => value.theme),
    // A damaged file must still allow Settings to open and display its read error.
    Effect.catch((error) => Effect.logWarning('Could not read initial theme', error).pipe(
      Effect.as('system' as const)
    ))
  )
  nativeTheme.themeSource = theme

  /** Covers the native surface exposed before the renderer paints and while it closes. */
  const updateBackgrounds = (): void => {
    const color = getRendererBackgroundColor()
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.setBackgroundColor(color)
    }
  }
  yield* Effect.acquireRelease(
    Effect.sync(() => nativeTheme.on('updated', updateBackgrounds)),
    () => Effect.sync(() => nativeTheme.removeListener('updated', updateBackgrounds))
  )

  yield* config.watch.pipe(
    // Reconnect after a configuration read error so a repaired file can recover.
    Stream.retry(Schedule.spaced('1 second')),
    Stream.runForEach((value) => Effect.sync(() => {
      nativeTheme.themeSource = value.theme
      updateBackgrounds()
    })),
    Effect.forkScoped
  )
}))
