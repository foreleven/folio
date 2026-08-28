import { SystemRpcClient } from '../rpc/system-rpc'
import { makeThrottledRefresh } from './throttle'

/** Throttled refresh action for the AtomRpc system-info query. */
export const requestSystemInfoAtom = makeThrottledRefresh(
  SystemRpcClient.runtime,
  SystemRpcClient.getSystemInfo,
  { duration: '1 second' }
)
