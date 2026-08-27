import { Effect, Layer, Stream } from 'effect'
import { describe, expect, it } from 'vitest'
import { ElectronApp } from './electron/ElectronApp'
import { MainWindow } from './electron/MainWindow'
import { application } from './program'

describe('main application program', () => {
  it('drives Electron lifecycle events through application services', async () => {
    const actions: Array<string> = []
    const ElectronAppTest = Layer.succeed(ElectronApp)({
      metadata: Effect.succeed({
        version: '1.2.3',
        path: '/test/folio',
        isPackaged: false
      }),
      whenReady: Effect.sync(() => {
        actions.push('ready')
      }),
      events: Stream.make(
        { _tag: 'Activate' as const },
        { _tag: 'WindowAllClosed' as const }
      ),
      quitOnWindowAllClosed: true,
      quit: Effect.sync(() => {
        actions.push('quit')
      })
    })
    const MainWindowTest = Layer.succeed(MainWindow)({
      open: Effect.sync(() => {
        actions.push('open')
      }),
      isOpen: Effect.sync(() => {
        actions.push('is-open')
        return false
      })
    })

    await Effect.runPromise(
      application.pipe(
        Effect.provide(Layer.merge(ElectronAppTest, MainWindowTest))
      )
    )

    expect(actions).toEqual(['ready', 'open', 'is-open', 'open', 'quit'])
  })

  it('keeps an existing window and preserves the macOS application process', async () => {
    const actions: Array<string> = []
    const ElectronAppTest = Layer.succeed(ElectronApp)({
      metadata: Effect.succeed({
        version: '1.2.3',
        path: '/test/folio',
        isPackaged: false
      }),
      whenReady: Effect.sync(() => {
        actions.push('ready')
      }),
      events: Stream.make(
        { _tag: 'Activate' as const },
        { _tag: 'WindowAllClosed' as const }
      ),
      quitOnWindowAllClosed: false,
      quit: Effect.sync(() => {
        actions.push('quit')
      })
    })
    const MainWindowTest = Layer.succeed(MainWindow)({
      open: Effect.sync(() => {
        actions.push('open')
      }),
      isOpen: Effect.sync(() => {
        actions.push('is-open')
        return true
      })
    })

    await Effect.runPromise(
      application.pipe(
        Effect.provide(Layer.merge(ElectronAppTest, MainWindowTest))
      )
    )

    expect(actions).toEqual(['ready', 'open', 'is-open'])
  })
})
