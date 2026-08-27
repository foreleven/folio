import { app } from 'electron'
import { injectable } from 'inversify'
import type { SystemInfo } from '../../shared/handlers/system-rpc-handler'

/** Stable DI token for process-owned system information. */
export const SystemService = Symbol.for('folio.services.SystemService')

/** Supplies application metadata without exposing Electron to RPC handlers. */
export interface SystemService {
  /** Returns stable runtime metadata for the current application process. */
  getInfo(): SystemInfo
}

/** Supplies process-owned application metadata to RPC handlers. */
@injectable()
export class ElectronSystemService implements SystemService {
  /** Returns stable runtime metadata without exposing the Electron app object. */
  public getInfo(): SystemInfo {
    return {
      platform: process.platform,
      version: app.getVersion()
    }
  }
}
