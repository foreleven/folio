import { contextBridge, ipcRenderer } from 'electron'
import {
  ELECTRON_RPC_REQUEST_CHANNEL,
  ELECTRON_RPC_RESPONSE_CHANNEL,
  isElectronRpcFrame,
  type ElectronRpcBridge,
  type ElectronRpcFrame
} from '../shared/rpc/electron-rpc'

let responseListener: ((frame: ElectronRpcFrame) => void) | undefined

ipcRenderer.on(ELECTRON_RPC_RESPONSE_CHANNEL, (_event, frame: unknown) => {
  if (responseListener && isElectronRpcFrame(frame)) {
    responseListener(frame)
  }
})

const desktopRpc: ElectronRpcBridge = Object.freeze({
  /** Sends a serialized Effect RPC frame across the isolated preload seam. */
  send: (frame: ElectronRpcFrame) =>
    ipcRenderer.send(ELECTRON_RPC_REQUEST_CHANNEL, frame),
  /** Assigns the response listener owned by the scoped renderer runtime. */
  listen: (listener: (frame: ElectronRpcFrame) => void) => {
    responseListener = listener
  },
  /** Releases the response listener without exposing ipcRenderer to the page. */
  clearListener: () => {
    responseListener = undefined
  }
})

// Only the serialized Effect RPC transport crosses context isolation.
contextBridge.exposeInMainWorld('desktopRpc', desktopRpc)
