import { Context, Layer, Schema } from 'effect'
import {
  Rpc,
  RpcClient,
  RpcClientError,
  RpcGroup
} from 'effect/unstable/rpc'

/** Schema and runtime type for metadata owned by the Electron main process. */
export const SystemInfo = Schema.Struct({
  platform: Schema.Literals([
    'aix',
    'android',
    'darwin',
    'freebsd',
    'haiku',
    'linux',
    'openbsd',
    'sunos',
    'win32',
    'cygwin',
    'netbsd'
  ]),
  version: Schema.String
})

export type SystemInfo = typeof SystemInfo.Type

/** Effect RPC contract for retrieving application metadata. */
export const GetSystemInfo = Rpc.make('system.getInfo', {
  success: SystemInfo
})

/** Complete system RPC interface shared by the client and server layers. */
export class SystemRpcs extends RpcGroup.make(GetSystemInfo) {}

/** Effect service containing the generated system RPC client. */
export class SystemRpcClient extends Context.Service<
  SystemRpcClient,
  RpcClient.FromGroup<typeof SystemRpcs, RpcClientError.RpcClientError>
>()('folio/rpc/SystemRpcClient') {
  /** Retrieves system metadata without exposing the RPC wire tag to callers. */
  static readonly getInfo = (client: SystemRpcClient['Service']) =>
    client[GetSystemInfo._tag]()

  /** Builds the generated client from the active Effect RPC protocol. */
  static readonly layer = Layer.effect(SystemRpcClient, RpcClient.make(SystemRpcs))
}
