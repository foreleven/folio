import { VaultWindowContexts } from '../services/vault-window-contexts'
import { ipcMain, type IpcMainEvent, type WebContents, type WebContentsDidStartNavigationEventParams } from 'electron'
import { Effect, Layer, Option, Queue } from 'effect'
import { RpcSerialization, RpcServer } from 'effect/unstable/rpc'
import { ELECTRON_RPC_REQUEST_CHANNEL, ELECTRON_RPC_RESPONSE_CHANNEL, type ElectronRpcFrame, isElectronRpcFrame } from '../../shared/rpc/electron-rpc'
import { isElectronRpcClientMessage } from '../../shared/rpc/electron-rpc-message'

interface ElectronRpcConnection {
  readonly rendererClientId: number
  readonly sender: WebContents
}

interface TrackedWebContents {
  readonly sender: WebContents
  readonly onDestroyed: () => void
  readonly onNavigation: (details: WebContentsDidStartNavigationEventParams) => void
  readonly onProcessGone: () => void
  generation: number
}

interface IncomingFrame {
  readonly generation: number
  readonly frame: ElectronRpcFrame
  readonly sender: WebContents
}

/** Effect RPC server Protocol implemented over Electron's duplex IPC channels. */
const makeElectronRpcServerProtocol = RpcServer.Protocol.make((writeRequest) =>
  Effect.gen(function* () {
    const vaultWindows = yield* VaultWindowContexts
    const serialization = yield* RpcSerialization.RpcSerialization
    const parser = serialization.makeUnsafe()
    const disconnects = yield* Queue.unbounded<number>()
    const incoming = yield* Queue.unbounded<IncomingFrame>()
    const connections = new Map<number, ElectronRpcConnection>()
    const connectionIds = new Map<string, number>()
    const trackedWebContents = new Map<number, TrackedWebContents>()
    let nextClientId = 0

    /** Disconnects the old document and interrupts its streams without affecting other windows. */
    const disconnectSender = (senderId: number): void => {
      for (const [clientId, connection] of connections) {
        if (connection.sender.id !== senderId) {
          continue
        }
        connections.delete(clientId)
        vaultWindows.disconnect(clientId)
        connectionIds.delete(`${senderId}:${connection.rendererClientId}`)
        Queue.offerUnsafe(disconnects, clientId)
      }
    }

    /** Removes native lifecycle listeners only when the WebContents or protocol is disposed. */
    const untrackSender = (senderId: number): void => {
      const tracked = trackedWebContents.get(senderId)
      if (!tracked) return
      tracked.sender.removeListener('destroyed', tracked.onDestroyed)
      tracked.sender.removeListener('did-start-navigation', tracked.onNavigation)
      tracked.sender.removeListener('render-process-gone', tracked.onProcessGone)
      trackedWebContents.delete(senderId)
    }

    /** Tracks document generations before queueing frames, so pre-reload frames cannot become new requests. */
    const trackSender = (sender: WebContents): TrackedWebContents => {
      const existing = trackedWebContents.get(sender.id)
      if (existing) return existing
      const tracked: TrackedWebContents = {
        sender,
        generation: 0,
        onDestroyed: () => {
          disconnectSender(sender.id)
          untrackSender(sender.id)
        },
        onNavigation: (details) => {
          // Hash changes bind welcome to a vault without replacing its runtime.
          if (!details.isMainFrame || details.isSameDocument) return
          tracked.generation++
          disconnectSender(sender.id)
        },
        onProcessGone: () => {
          tracked.generation++
          disconnectSender(sender.id)
        }
      }
      trackedWebContents.set(sender.id, tracked)
      sender.once('destroyed', tracked.onDestroyed)
      sender.on('did-start-navigation', tracked.onNavigation)
      sender.on('render-process-gone', tracked.onProcessGone)
      return tracked
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
      vaultWindows.connect(clientId, sender.id)

      return clientId
    }

    /** Queues one validated outer frame; the scoped consumer preserves IPC order. */
    const onRequest = (event: IpcMainEvent, value: unknown): void => {
      if (!isElectronRpcFrame(value) || event.sender.isDestroyed()) {
        return
      }
      const { generation } = trackSender(event.sender)
      Queue.offerUnsafe(incoming, { frame: value, sender: event.sender, generation })
    }

    /** Decodes one queued frame and feeds only valid inner messages into Effect RPC. */
    const receive = ({ frame, sender, generation }: IncomingFrame) => {
      if (trackedWebContents.get(sender.id)?.generation !== generation) return Effect.void
      return Effect.try({
        try: () => parser.decode(frame.data),
        catch: (cause) => cause
      }).pipe(
        Effect.flatMap((messages) =>
          Effect.forEach(messages, (message) => {
            if (!isElectronRpcClientMessage(message)) {
              return Effect.logWarning('Ignored invalid Electron RPC client message')
            }
            // A previous message may have yielded while the document navigated.
            if (trackedWebContents.get(sender.id)?.generation !== generation) return Effect.void
            // Effect RPC rejects duplicate/ended requests by self-interrupting.
            // Contain that exit to this message so HMR cannot stop all IPC traffic.
            return writeRequest(getClientId(sender, frame.clientId), message).pipe(Effect.exit, Effect.asVoid)
          })
        ),
        Effect.catch((cause) => Effect.logWarning('Failed to decode Electron RPC request', cause)),
        Effect.asVoid
      )
    }

    // A single scoped consumer gives control frames deterministic ordering and
    // guarantees that no detached receive fiber survives protocol shutdown.
    yield* Effect.forkScoped(Effect.forever(Effect.flatMap(Queue.take(incoming), receive)))

    yield* Effect.acquireRelease(
      Effect.sync(() => ipcMain.on(ELECTRON_RPC_REQUEST_CHANNEL, onRequest)),
      () =>
        Effect.sync(() => {
          ipcMain.removeListener(ELECTRON_RPC_REQUEST_CHANNEL, onRequest)
          for (const senderId of trackedWebContents.keys()) {
            untrackSender(senderId)
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
          vaultWindows.disconnect(clientId)
          connectionIds.delete(`${connection.sender.id}:${connection.rendererClientId}`)
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
export const ElectronRpcServerProtocolLive = Layer.effect(RpcServer.Protocol, makeElectronRpcServerProtocol)
