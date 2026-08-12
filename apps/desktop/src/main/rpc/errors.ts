import type { JsonRpcErrorObject } from '../../shared/rpc'

/** A deliberate application/protocol failure that is safe to serialize to the renderer. */
export class JsonRpcError extends Error {
  public constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown
  ) {
    super(message)
    this.name = 'JsonRpcError'
  }

  /** Converts this error into the JSON-RPC wire representation. */
  public toObject(): JsonRpcErrorObject {
    return {
      code: this.code,
      message: this.message,
      ...(this.data === undefined ? {} : { data: this.data })
    }
  }
}
