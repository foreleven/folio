import { Effect, Layer, Stream } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { ElectronApp } from './electron/ElectronApp'
import { MainWindow } from './electron/MainWindow'
import { application } from './program'
// Electron's asset transform belongs to the bundler; lifecycle tests use an inert archive path.
vi.mock('../../../../packages/integrations/src/lark/assets/lark-cli-1.0.94-darwin-arm64.tar.gz?asset&asarUnpack', () => ({ default: '/test/lark-cli.tar.gz' }))
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/test/folio' } }))


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
      quit: Effect.sync(() => {
        actions.push('quit')
      })
    })
    const MainWindowTest = Layer.succeed(MainWindow)({
      openVault: () => Effect.void,
      closeVault: () => Effect.void,
      getVault: () => Effect.succeed(null),
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

    expect(actions).toEqual(['ready', 'open', 'is-open', 'open'])
  })

  it('keeps an existing window and preserves the background application process', async () => {
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
      quit: Effect.sync(() => {
        actions.push('quit')
      })
    })
    const MainWindowTest = Layer.succeed(MainWindow)({
      openVault: () => Effect.void,
      closeVault: () => Effect.void,
      getVault: () => Effect.succeed(null),
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
