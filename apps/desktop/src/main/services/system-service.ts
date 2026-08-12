import { app } from 'electron'
import { injectable } from 'inversify'
import type { SystemInfo } from '../../shared/rpc'

/** Supplies process-owned application metadata to RPC handlers. */
@injectable()
export class SystemService {
  /** Returns stable runtime metadata without exposing the Electron app object. */
  public getInfo(): SystemInfo {
    return {
      platform: process.platform,
      version: app.getVersion()
    }
  }
}
