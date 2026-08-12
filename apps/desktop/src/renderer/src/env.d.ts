/// <reference types="vite/client" />

import type { DesktopRpcClient } from '../../shared/rpc'

declare global {
  interface Window {
    desktop: Readonly<DesktopRpcClient>
  }
}

export {}
