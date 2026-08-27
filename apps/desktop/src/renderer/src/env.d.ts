/// <reference types="vite/client" />

interface DesktopRpcBridge {
  /** Sends an untyped transport request; injected service contracts provide application types. */
  request(method: string, ...args: [] | [params: unknown]): Promise<unknown>
}

declare global {
  interface Window {
    desktop: Readonly<DesktopRpcBridge>
  }
}

export {}
