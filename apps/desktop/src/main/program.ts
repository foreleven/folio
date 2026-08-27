import { Effect, Layer, Stream } from 'effect'
import { ElectronApp, type ElectronAppEvent } from './electron/ElectronApp'
import { MainWindow } from './electron/MainWindow'
import { MainRpcLive } from './rpc/runtime'

/** Handles one Electron lifecycle event through the injected application services. */
const handleEvent = Effect.fn('main.handleElectronEvent')(
  function*(event: ElectronAppEvent) {
    const electronApp = yield* ElectronApp
    const mainWindow = yield* MainWindow

    switch (event._tag) {
      case 'Activate':
        if (!(yield* mainWindow.isOpen)) {
          yield* mainWindow.open
        }
        return
      case 'WindowAllClosed':
        if (electronApp.quitOnWindowAllClosed) {
          yield* electronApp.quit
        }
    }
  }
)

/** Main application workflow, independent of concrete Electron adapters. */
export const application = Effect.gen(function*() {
  const electronApp = yield* ElectronApp
  const mainWindow = yield* MainWindow

  yield* electronApp.whenReady
  yield* mainWindow.open
  yield* Stream.runForEach(electronApp.events, handleEvent)
})

/** Complete main-process layer with one shared Electron application boundary. */
export const MainLive = Layer.merge(MainWindow.layer, MainRpcLive).pipe(
  Layer.provideMerge(ElectronApp.layer)
)

/** Fully wired process program; completion releases every scoped main resource. */
export const program = application.pipe(Effect.provide(MainLive))
