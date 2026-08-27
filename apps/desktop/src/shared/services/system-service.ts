/** Application metadata available on both sides of the RPC boundary. */
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

/** Stable DI token for system capabilities in both process containers. */
export const SystemService = Symbol.for('folio.services.SystemService')

/** Process-independent contract for the system service. */
export interface SystemService {
  /** Returns current application metadata locally or through an asynchronous proxy. */
  getInfo(): SystemInfo | Promise<SystemInfo>
}
