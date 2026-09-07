import { Rpc, RpcGroup } from 'effect/unstable/rpc'
import { ConfigStoreError, GlobalConfig, GlobalConfigPatch } from '../config'

/** Streams persisted preferences so independent windows stay in sync. */
export const WatchConfig = Rpc.make('config.watch', {
  success: GlobalConfig,
  error: ConfigStoreError,
  stream: true
})

/** Validated partial updates; the server returns only successfully persisted values. */
export const UpdateConfig = Rpc.make('config.update', {
  payload: GlobalConfigPatch,
  success: GlobalConfig,
  error: ConfigStoreError
})

export class ConfigRpcs extends RpcGroup.make(WatchConfig, UpdateConfig) {}
