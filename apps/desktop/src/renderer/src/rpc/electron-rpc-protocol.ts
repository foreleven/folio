import { Context, Effect, Layer, Queue } from 'effect'
import {
  RpcClient,
  RpcClientError,
  type RpcMessage,
  RpcSerialization
} from 'effect/unstable/rpc'
import {
  type ElectronRpcBridge,
  type ElectronRpcFrame,
  isElectronRpcFrame
} from '../../../shared/rpc/electron-rpc'
import { isElectronRpcServerMessage } from '../../../shared/rpc/electron-rpc-message'

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
      const incoming = yield* Queue.unbounded<ElectronRpcFrame>()
      const knownClientIds = new Set<number>()

      /** Encodes one client message and enforces Electron's text-only framing. */
      const encode = (message: RpcMessage.FromClientEncoded): string => {
        const data = parser.encode(message)
        if (typeof data !== 'string') {
          throw new TypeError('Electron RPC serialization did not produce text')
        }
        return data
      }

      const broadcastError = (error: RpcClientError.RpcClientError) =>
        Effect.forEach(clientIds, (clientId) =>
          writeResponse(clientId, { _tag: 'ClientProtocolError', error })
        ).pipe(Effect.asVoid)

      /** Decodes one queued frame and routes only valid messages to Effect RPC. */
      const receive = (frame: ElectronRpcFrame) =>
        Effect.try({
          try: () => parser.decode(frame.data),
          catch: (cause) => protocolError('Error decoding Electron RPC response', cause)
        }).pipe(
          Effect.flatMap((responses) =>
            Effect.forEach(responses, (response) =>
              isElectronRpcServerMessage(response)
                ? writeResponse(frame.clientId, response)
                : Effect.fail(
                    protocolError('Invalid Electron RPC response', response)
                  )
            )
          ),
          Effect.catch(broadcastError),
          Effect.asVoid
        )

      yield* Effect.acquireRelease(
        Effect.sync(() => {
          bridge.listen((frame) => {
            if (isElectronRpcFrame(frame)) {
              Queue.offerUnsafe(incoming, frame)
            }
          })
        }),
        () =>
          Effect.sync(() => {
            try {
              // Eof releases main-process mappings during reload/HMR even though
              // the underlying WebContents remains alive.
              for (const clientId of knownClientIds) {
                bridge.send({ clientId, data: encode({ _tag: 'Eof' }) })
              }
            } finally {
              knownClientIds.clear()
              bridge.clearListener()
            }
          })
      )

      // One scoped consumer preserves Chunk/Exit order and is interrupted with
      // the renderer runtime instead of leaving detached fibers behind.
      yield* Effect.forkScoped(
        Effect.forever(Effect.flatMap(Queue.take(incoming), receive))
      )

      return {
        /** Serializes one Effect RPC client message into an Electron IPC frame. */
        send: (clientId, request) =>
          Effect.try({
            try: () => {
              bridge.send({ clientId, data: encode(request) })
              knownClientIds.add(clientId)
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
