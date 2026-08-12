import { ipcMain } from 'electron'
import { RPC_CHANNEL } from '../../shared/rpc'
import type { JsonRpcServer } from './server'

/** Registers the sole Electron transport adapter for the JSON-RPC server. */
export function registerElectronRpc(server: JsonRpcServer): void {
  ipcMain.handle(RPC_CHANNEL, (_event, message: unknown) => server.handleMessage(message))
}
