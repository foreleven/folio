import { Context, Effect, Layer } from 'effect'
import {
  RpcClient,
  RpcClientError,
  type RpcMessage,
  RpcSerialization
} from 'effect/unstable/rpc'
import type { ElectronRpcBridge } from '../../../shared/rpc/electron-rpc'

/** Effect service for the context-isolated preload transport bridge. */
export class ElectronRpcBridgeService extends Context.Service<
  ElectronRpcBridgeService,
  ElectronRpcBridge
>()('folio/renderer/ElectronRpcBridge') {
  /** Live adapter exposed by the Electron preload script. */
  static readonly layer = Layer.effect(
    ElectronRpcBridgeService,
    Effect.sync(() => window.desktopRpc)
  )
}

/** Converts transport defects into the error type expected by Effect RPC clients. */
function protocolError(message: string, cause: unknown): RpcClientError.RpcClientError {
  return new RpcClientError.RpcClientError({
    reason: new RpcClientError.RpcClientDefect({ message, cause })
  })
}

/** Effect RPC client Protocol implemented over the isolated Electron bridge. */
const makeElectronRpcClientProtocol = RpcClient.Protocol.make(
  (writeResponse, clientIds) =>
    Effect.gen(function*() {
      const bridge = yield* ElectronRpcBridgeService
      const serialization = yield* RpcSerialization.RpcSerialization
      const parser = serialization.makeUnsafe()

      const broadcastError = (error: RpcClientError.RpcClientError) =>
        Effect.forEach(clientIds, (clientId) =>
          writeResponse(clientId, { _tag: 'ClientProtocolError', error })
        ).pipe(Effect.asVoid)

      yield* Effect.acquireRelease(
        Effect.sync(() => {
          bridge.listen((frame) => {
            const receive = Effect.try({
              try: () => parser.decode(frame.data) as Array<RpcMessage.FromServerEncoded>,
              catch: (cause) => protocolError('Error decoding Electron RPC response', cause)
            }).pipe(
              Effect.flatMap((responses) =>
                Effect.forEach(responses, (response) =>
                  writeResponse(frame.clientId, response)
                )
              ),
              Effect.catch(broadcastError),
              Effect.asVoid
            )

            Effect.runFork(receive)
          })
        }),
        () => Effect.sync(() => bridge.clearListener())
      )

      return {
        /** Serializes one Effect RPC client message into an Electron IPC frame. */
        send: (clientId, request) =>
          Effect.try({
            try: () => {
              const data = parser.encode(request)
              if (typeof data !== 'string') {
                throw new TypeError('Electron RPC serialization did not produce text')
              }
              bridge.send({ clientId, data })
            },
            catch: (cause) => protocolError('Error sending Electron RPC request', cause)
          }),
        supportsAck: true,
        supportsTransferables: false,
        codecFor: serialization.codecFor
      }
    })
)

/** Scoped client Protocol layer for Electron's duplex IPC transport. */
export const ElectronRpcClientProtocolLive = Layer.effect(
  RpcClient.Protocol,
  makeElectronRpcClientProtocol
)
