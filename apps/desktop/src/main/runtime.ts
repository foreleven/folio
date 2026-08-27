import { app } from 'electron'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { MainRpcLive } from './rpc/runtime'

/** Complete main-process Layer for RPC and application-owned services. */
export const MainLive = Layer.mergeAll(MainRpcLive)

/** The one application runtime; its scope owns the main RPC server. */
export type MainRuntime = ManagedRuntime.ManagedRuntime<never, never>

/** Imperative Electron edges driven by the main Effect runtime. */
export interface MainApplication {
  readonly createWindow: () => void
  readonly activate: () => void
  readonly windowAllClosed: () => void
}

/** Creates the application runtime owned by Electron's main process. */
export function createMainRuntime(): MainRuntime {
  return ManagedRuntime.make(MainLive)
}

/**
 * Boots the main process inside Effect: Electron readiness is awaited before
 * creating the window, while the ManagedRuntime keeps MainLive resources alive
 * until `dispose` is called from Electron's before-quit lifecycle.
 */
export function startMainRuntime(
  runtime: MainRuntime,
  application: MainApplication
): Promise<void> {
  return runtime.runPromise(
    Effect.promise(() => app.whenReady()).pipe(
      Effect.andThen(Effect.sync(application.createWindow)),
      Effect.andThen(
        Effect.sync(() => {
          // Electron callbacks are kept at the process boundary; each one is
          // installed only after MainLive has been initialized.
          app.on('activate', application.activate)
          app.on('window-all-closed', application.windowAllClosed)
          app.on('before-quit', () => void runtime.dispose())
        })
      )
    )
  )
}
