import { Effect, Layer, Stream } from 'effect'
import { describe, expect, it } from 'vitest'
import { ElectronApp } from '../electron/ElectronApp'
import { SystemService } from './system-service'

describe('SystemService', () => {
  it('reads the application version from the ElectronApp boundary', async () => {
    const ElectronAppTest = Layer.succeed(ElectronApp)({
      metadata: Effect.succeed({
        version: '9.8.7',
        path: '/test/folio',
        isPackaged: false
      }),
      whenReady: Effect.void,
      events: Stream.empty,
      quitOnWindowAllClosed: false,
      quit: Effect.void
    })
    const program = Effect.gen(function*() {
      const system = yield* SystemService
      return yield* system.getInfo
    }).pipe(
      Effect.provide(SystemService.layer),
      Effect.provide(ElectronAppTest)
    )

    await expect(Effect.runPromise(program)).resolves.toEqual({
      platform: process.platform,
      version: '9.8.7'
    })
  })
})
