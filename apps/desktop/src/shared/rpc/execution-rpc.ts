import { Rpc, RpcGroup } from 'effect/unstable/rpc'
import { GlobalTaskStatus } from '../execution'
import { ConfigStoreError } from '../config'

/** Application-wide summary; intentionally independent of the current window's Vault. */
export class ExecutionRpcs extends RpcGroup.make(
  Rpc.make('executions.status', { success: GlobalTaskStatus, error: ConfigStoreError })
) {}
