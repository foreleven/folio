import { Context, Effect, Layer } from 'effect'
import type { SystemInfo } from '../../shared/rpc/system-rpc'
import { ElectronApp } from '../electron/ElectronApp'

/** Effect service for process-owned application metadata. */
export class SystemService extends Context.Service<
  SystemService,
  {
    /** Reads stable runtime metadata from the Electron main process. */
    readonly getInfo: Effect.Effect<SystemInfo>
    readonly count: (c: number) => Effect.Effect<number>
  }
>()('folio/services/SystemService') {
  /** Live adapter backed by Electron's application object and Node platform. */
  static readonly layer = Layer.effect(
    SystemService,
    Effect.gen(function*() {
      const electronApp = yield* ElectronApp

      return SystemService.of({
        getInfo: electronApp.metadata.pipe(
          Effect.map(({ version }) => ({
            platform: process.platform,
            version
          }))
        ),
        count: (c: number) => Effect.succeed(c)
      })
    })
  )
}
