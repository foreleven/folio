/** Stable dependency-injection tokens for the main-process RPC graph. */
export const RPC_TYPES = {
  jsonRpcMethodHandler: Symbol.for('folio.rpc.JsonRpcMethodHandler'),
  jsonRpcServer: Symbol.for('folio.rpc.JsonRpcServer'),
  systemService: Symbol.for('folio.services.SystemService')
} as const
