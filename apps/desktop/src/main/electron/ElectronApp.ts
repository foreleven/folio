import { app } from 'electron'
import { Cause, Context, Effect, Layer, Queue, Schema, Stream } from 'effect'

export const AppMetadata = Schema.Struct({
  version: Schema.String,
  path: Schema.String,
  isPackaged: Schema.Boolean
})

export type AppMetadata = typeof AppMetadata.Type

export type ElectronAppEvent =
  | { readonly _tag: 'Activate' }
  | { readonly _tag: 'WindowAllClosed' }

/** Process-level Electron boundary used by the main application program. */
export class ElectronApp extends Context.Service<
  ElectronApp,
  {
    /** Reads metadata owned by Electron's application process. */
    readonly metadata: Effect.Effect<AppMetadata>
    /** Suspends startup until Electron is ready to create browser windows. */
    readonly whenReady: Effect.Effect<void>
    /** Emits lifecycle events until Electron begins quitting. */
    readonly events: Stream.Stream<ElectronAppEvent>
    /** Requests a normal Electron application shutdown. */
    readonly quit: Effect.Effect<void>
  }
>()('folio/main/electron/ElectronApp') {
  /** Owns the quit barrier for the lifetime of the outer application layer, including dependent cleanup. */
  static readonly layer = Layer.effect(ElectronApp, Effect.gen(function*() {
    const events = yield* Queue.unbounded<ElectronAppEvent, Cause.Done>()
    let quitRequested = false
    const onActivate = () => { if (!quitRequested) Queue.offerUnsafe(events, { _tag: 'Activate' }) }
    const onWindowAllClosed = () => { if (!quitRequested) Queue.offerUnsafe(events, { _tag: 'WindowAllClosed' }) }
    const onBeforeQuit = (event: { preventDefault(): void }) => {
      // End the application workflow while keeping Electron alive for asynchronous resource cleanup.
      // Repeated quit requests must remain intercepted until this outer layer is released.
      event.preventDefault()
      quitRequested = true
      Queue.endUnsafe(events)
    }
    yield* Effect.acquireRelease(Effect.sync(() => {
      app.on('activate', onActivate)
      app.on('window-all-closed', onWindowAllClosed)
      app.on('before-quit', onBeforeQuit)
    }), () => Effect.sync(() => {
      app.removeListener('activate', onActivate)
      app.removeListener('window-all-closed', onWindowAllClosed)
      app.removeListener('before-quit', onBeforeQuit)
      // MainLive provides this layer outside its services, so their finalizers finish first.
      if (quitRequested) app.quit()
    }))
    return ElectronApp.of({
      metadata: Effect.sync(() => ({ version: app.getVersion(), path: app.getAppPath(), isPackaged: app.isPackaged })),
      whenReady: Effect.promise(() => app.whenReady()),
      events: Stream.fromQueue(events),
      quit: Effect.sync(() => app.quit())
    })
  }))
}
