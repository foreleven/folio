/** Electron IPC channels used by the duplex Effect RPC protocol. */
export const ELECTRON_RPC_REQUEST_CHANNEL = 'folio:rpc:request'
export const ELECTRON_RPC_RESPONSE_CHANNEL = 'folio:rpc:response'

/** One serialized Effect RPC frame associated with a renderer-side client. */
export interface ElectronRpcFrame {
  readonly clientId: number
  readonly data: string
}

/** Isolated renderer bridge used by the Effect RPC client protocol. */
export interface ElectronRpcBridge {
  /** Sends one serialized client frame to the main process. */
  readonly send: (frame: ElectronRpcFrame) => void
  /** Installs the single response listener owned by the renderer runtime. */
  readonly listen: (listener: (frame: ElectronRpcFrame) => void) => void
  /** Removes the current response listener when the runtime scope closes. */
  readonly clearListener: () => void
}

/** Validates an IPC value before either Effect RPC protocol consumes it. */
export function isElectronRpcFrame(value: unknown): value is ElectronRpcFrame {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const frame = value as Record<string, unknown>
  return (
    Number.isSafeInteger(frame.clientId) &&
    (frame.clientId as number) >= 0 &&
    typeof frame.data === 'string'
  )
}
