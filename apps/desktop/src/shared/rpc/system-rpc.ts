import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/unstable/rpc'

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

/** Complete system RPC contract shared by the renderer client and main server. */
export class SystemRpcs extends RpcGroup.make(GetSystemInfo) {}
