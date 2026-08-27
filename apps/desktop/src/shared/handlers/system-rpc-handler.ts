import { defineRpcClient, type RpcHandlerToken } from '../rpc'

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
export const SystemRpcHandler = Symbol.for(
  'folio.rpc.SystemRpcHandler'
) as RpcHandlerToken<SystemRpcHandler>

/** Client/server contract for methods exposed under the system namespace. */
export interface SystemRpcHandler {
  /** Returns current application metadata through an asynchronous RPC boundary. */
  getInfo(): Promise<SystemInfo>
}

/** Namespace and public method metadata shared by both process composition roots. */
export const SYSTEM_RPC_DEFINITION = defineRpcClient<SystemRpcHandler>('system', {
  getInfo: true
})
