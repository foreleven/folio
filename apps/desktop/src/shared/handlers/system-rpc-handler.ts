/** Application metadata returned by the system RPC handler. */
export interface SystemInfo {
  platform:
    | 'aix'
    | 'android'
    | 'darwin'
    | 'freebsd'
    | 'haiku'
    | 'linux'
    | 'openbsd'
    | 'sunos'
    | 'win32'
    | 'cygwin'
    | 'netbsd'
  version: string
}

/** Stable DI token for the system RPC handler in both process containers. */
export const SystemRpcHandler = Symbol.for('folio.rpc.SystemRpcHandler')

/** Client/server contract for methods exposed under the system namespace. */
export interface SystemRpcHandler {
  /** Returns current application metadata locally or through the renderer proxy. */
  getInfo(): SystemInfo | Promise<SystemInfo>
}
