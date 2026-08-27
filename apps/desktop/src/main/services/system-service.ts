import { Context, Effect, Layer } from 'effect'
import { app } from 'electron'
import type { SystemInfo } from '../../shared/rpc/system-rpc'

/** Effect service for process-owned application metadata. */
export class SystemService extends Context.Service<
  SystemService,
  {
    /** Reads stable runtime metadata from the Electron main process. */
    readonly getInfo: Effect.Effect<SystemInfo>
  }
>()('folio/services/SystemService') {
  /** Live adapter backed by Electron's application object and Node platform. */
  static readonly layer = Layer.succeed(SystemService)({
    getInfo: Effect.sync(() => ({
      platform: process.platform,
      version: app.getVersion()
    }))
  })
}
