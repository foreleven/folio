import { app } from 'electron'
import { Context, Effect, Layer, Queue, Schema, Stream } from 'effect'

export const AppMetadata = Schema.Struct({
  version: Schema.String,
  path: Schema.String,
  isPackaged: Schema.Boolean
})

export type AppMetadata = typeof AppMetadata.Type

export type ElectronAppEvent =
  | { readonly _tag: 'Activate' }
  | { readonly _tag: 'WindowAllClosed' }

const events = Stream.callback<ElectronAppEvent>(
  Effect.fn('ElectronApp.events')(function*(queue) {
    const onActivate = () =>
      Queue.offerUnsafe(queue, { _tag: 'Activate' } as const)
    const onWindowAllClosed = () =>
      Queue.offerUnsafe(queue, { _tag: 'WindowAllClosed' } as const)
    // Ending the stream lets the application program complete and release all
    // scoped resources before Electron finishes its normal quit sequence.
    const onBeforeQuit = () => Queue.endUnsafe(queue)

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        app.on('activate', onActivate)
        app.on('window-all-closed', onWindowAllClosed)
        app.on('before-quit', onBeforeQuit)
      }),
      () =>
        Effect.sync(() => {
          app.removeListener('activate', onActivate)
          app.removeListener('window-all-closed', onWindowAllClosed)
          app.removeListener('before-quit', onBeforeQuit)
        })
    )
  })
)

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
    /** Whether closing every window should terminate this platform's process. */
    readonly quitOnWindowAllClosed: boolean
    /** Requests a normal Electron application shutdown. */
    readonly quit: Effect.Effect<void>
  }
>()('folio/main/electron/ElectronApp') {
  /** Live adapter backed by Electron's process-global application object. */
  static readonly layer = Layer.succeed(ElectronApp)({
    metadata: Effect.sync(() => ({
      version: app.getVersion(),
      path: app.getAppPath(),
      isPackaged: app.isPackaged
    })),
    whenReady: Effect.promise(() => app.whenReady()),
    events,
    quitOnWindowAllClosed: process.platform !== 'darwin',
    quit: Effect.sync(() => app.quit())
  })
}
