/// <reference types="vite/client" />

import type { ElectronRpcBridge } from '../../shared/rpc/electron-rpc'

declare global {
  interface Window {
    desktopRpc: Readonly<ElectronRpcBridge>
  }
}

export {}
