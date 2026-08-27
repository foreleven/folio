import { app } from 'electron'
import { injectable } from 'inversify'
import {
  SystemService as SharedSystemService,
  type SystemInfo
} from '../../shared/services/system-service'

/** Main-process DI token shared with renderer-side service injection. */
export const SystemService = SharedSystemService

/** Narrows the cross-process service contract to its synchronous local implementation. */
export interface SystemService extends SharedSystemService {
  /** Returns metadata synchronously because Electron owns it in this process. */
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
