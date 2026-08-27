import { ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import { Effect, Layer, Option, Queue } from 'effect'
import {
  type RpcMessage,
  RpcSerialization,
  RpcServer
} from 'effect/unstable/rpc'
import {
  ELECTRON_RPC_REQUEST_CHANNEL,
  ELECTRON_RPC_RESPONSE_CHANNEL,
  type ElectronRpcFrame,
  isElectronRpcFrame
} from '../../shared/rpc/electron-rpc'
import { isElectronRpcClientMessage } from '../../shared/rpc/electron-rpc-message'

interface ElectronRpcConnection {
  readonly rendererClientId: number
  readonly sender: WebContents
}

interface TrackedWebContents {
  readonly sender: WebContents
  readonly onDestroyed: () => void
}

interface IncomingFrame {
  readonly frame: ElectronRpcFrame
  readonly sender: WebContents
}

/** Effect RPC server Protocol implemented over Electron's duplex IPC channels. */
const makeElectronRpcServerProtocol = RpcServer.Protocol.make((writeRequest) =>
  Effect.gen(function*() {
    const serialization = yield* RpcSerialization.RpcSerialization
    const parser = serialization.makeUnsafe()
    const disconnects = yield* Queue.unbounded<number>()
    const incoming = yield* Queue.unbounded<IncomingFrame>()
    const connections = new Map<number, ElectronRpcConnection>()
    const connectionIds = new Map<string, number>()
    const trackedWebContents = new Map<number, TrackedWebContents>()
    let nextClientId = 0

    /** Removes all Effect RPC clients owned by a destroyed renderer process. */
    const disconnectSender = (senderId: number): void => {
      for (const [clientId, connection] of connections) {
        if (connection.sender.id !== senderId) {
          continue
        }
        connections.delete(clientId)
        connectionIds.delete(`${senderId}:${connection.rendererClientId}`)
        Queue.offerUnsafe(disconnects, clientId)
      }
      trackedWebContents.delete(senderId)
    }

    /** Stops tracking a renderer once it owns no logical RPC clients. */
    const untrackIdleSender = (senderId: number): void => {
      for (const connection of connections.values()) {
        if (connection.sender.id === senderId) {
          return
        }
      }

      const tracked = trackedWebContents.get(senderId)
      if (tracked) {
        tracked.sender.removeListener('destroyed', tracked.onDestroyed)
        trackedWebContents.delete(senderId)
      }
    }

    /** Finds or creates the server-side client identity for one renderer runtime. */
    const getClientId = (sender: WebContents, rendererClientId: number): number => {
      const key = `${sender.id}:${rendererClientId}`
      const existing = connectionIds.get(key)
      if (existing !== undefined) {
        return existing
      }

      const clientId = nextClientId++
      connectionIds.set(key, clientId)
      connections.set(clientId, { rendererClientId, sender })

      if (!trackedWebContents.has(sender.id)) {
        const onDestroyed = () => disconnectSender(sender.id)
        trackedWebContents.set(sender.id, { sender, onDestroyed })
        sender.once('destroyed', onDestroyed)
      }

      return clientId
    }

    /** Queues one validated outer frame; the scoped consumer preserves IPC order. */
    const onRequest = (event: IpcMainEvent, value: unknown): void => {
      if (!isElectronRpcFrame(value)) {
        return
      }
      Queue.offerUnsafe(incoming, { frame: value, sender: event.sender })
    }

    /** Decodes one queued frame and feeds only valid inner messages into Effect RPC. */
    const receive = ({ frame, sender }: IncomingFrame) =>
      Effect.try({
        try: () => parser.decode(frame.data),
        catch: (cause) => cause
      }).pipe(
        Effect.flatMap((messages) =>
          Effect.forEach(messages, (message) => {
            if (!isElectronRpcClientMessage(message)) {
              return Effect.logWarning('Ignored invalid Electron RPC client message')
            }
            return writeRequest(getClientId(sender, frame.clientId), message)
          })
        ),
        Effect.catch((cause) => Effect.logWarning('Failed to decode Electron RPC request', cause)),
        Effect.asVoid
      )

    // A single scoped consumer gives control frames deterministic ordering and
    // guarantees that no detached receive fiber survives protocol shutdown.
    yield* Effect.forkScoped(
      Effect.forever(Effect.flatMap(Queue.take(incoming), receive))
    )

    yield* Effect.acquireRelease(
      Effect.sync(() => ipcMain.on(ELECTRON_RPC_REQUEST_CHANNEL, onRequest)),
      () =>
        Effect.sync(() => {
          ipcMain.removeListener(ELECTRON_RPC_REQUEST_CHANNEL, onRequest)
          for (const { onDestroyed, sender } of trackedWebContents.values()) {
            sender.removeListener('destroyed', onDestroyed)
          }
        })
    )

    return {
      disconnects,
      /** Serializes one Effect RPC response to its originating renderer client. */
      send: (clientId, response) =>
        Effect.sync(() => {
          const connection = connections.get(clientId)
          if (!connection || connection.sender.isDestroyed()) {
            return
          }
          const data = parser.encode(response)
          if (typeof data !== 'string') {
            throw new TypeError('Electron RPC serialization did not produce text')
          }
          connection.sender.send(ELECTRON_RPC_RESPONSE_CHANNEL, {
            clientId: connection.rendererClientId,
            data
          })
        }),
      /** Releases one logical client without affecting sibling renderer clients. */
      end: (clientId) =>
        Effect.sync(() => {
          const connection = connections.get(clientId)
          if (!connection) {
            return
          }
          connections.delete(clientId)
          connectionIds.delete(`${connection.sender.id}:${connection.rendererClientId}`)
          untrackIdleSender(connection.sender.id)
        }),
      clientIds: Effect.sync(() => new Set(connections.keys())),
      initialMessage: Effect.succeed(Option.none()),
      supportsAck: true,
      supportsTransferables: false,
      supportsSpanPropagation: true,
      supportsNotifications: true,
      codecFor: serialization.codecFor
    }
  })
)

/** Scoped server Protocol layer for Electron's duplex IPC transport. */
export const ElectronRpcServerProtocolLive = Layer.effect(
  RpcServer.Protocol,
  makeElectronRpcServerProtocol
)
