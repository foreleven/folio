import { Deferred, Effect, Layer } from 'effect'
import {
  RpcMessage,
  RpcSerialization,
  RpcServer
} from 'effect/unstable/rpc'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ELECTRON_RPC_REQUEST_CHANNEL,
  ELECTRON_RPC_RESPONSE_CHANNEL
} from '../../shared/rpc/electron-rpc'
import { ElectronRpcServerProtocolLive } from './electron-rpc-protocol'

const electronMocks = vi.hoisted(() => ({
  on: vi.fn(),
  removeListener: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: electronMocks.on,
    removeListener: electronMocks.removeListener
  }
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Electron Effect RPC server protocol', () => {
  it('routes renderer frames through an isolated server client connection', async () => {
    const send = vi.fn()
    const once = vi.fn()
    const removeWebContentsListener = vi.fn()
    const sender = {
      id: 42,
      isDestroyed: () => false,
      once,
      removeListener: removeWebContentsListener,
      send
    }
    const request: RpcMessage.FromClientEncoded = {
      _tag: 'Request',
      id: 1,
      tag: 'system.getInfo',
      payload: undefined,
      headers: []
    }
    const response: RpcMessage.FromServerEncoded = {
      _tag: 'Exit',
      requestId: 1,
      exit: { _tag: 'Success', value: { platform: 'darwin', version: '1.2.3' } }
    }
    const TestProtocol = ElectronRpcServerProtocolLive.pipe(
      Layer.provide(RpcSerialization.layerJson)
    )
    const program = Effect.gen(function*() {
      const protocol = yield* RpcServer.Protocol
      const received = yield* Deferred.make<
        readonly [number, RpcMessage.FromClientEncoded]
      >()
      yield* Effect.forkScoped(
        protocol.run((clientId, message) =>
          message._tag === 'Eof'
            ? protocol.end(clientId)
            : Deferred.succeed(received, [clientId, message]).pipe(Effect.asVoid)
        )
      )
      const receive = electronMocks.on.mock.calls[0]?.[1] as (
        event: { sender: typeof sender },
        frame: unknown
      ) => void

      receive(
        { sender },
        { clientId: 7, data: JSON.stringify(request) }
      )
      const [serverClientId, receivedRequest] = yield* Deferred.await(received)
      yield* protocol.send(serverClientId, response)

      receive(
        { sender },
        { clientId: 7, data: JSON.stringify({ _tag: 'Eof' }) }
      )
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(removeWebContentsListener).toHaveBeenCalledOnce())
      )

      return { receivedRequest, clientIds: yield* protocol.clientIds }
    }).pipe(Effect.provide(TestProtocol), Effect.scoped)

    await expect(Effect.runPromise(program)).resolves.toEqual({
      receivedRequest: request,
      clientIds: new Set()
    })
    expect(electronMocks.on).toHaveBeenCalledWith(
      ELECTRON_RPC_REQUEST_CHANNEL,
      expect.any(Function)
    )
    expect(send).toHaveBeenCalledWith(ELECTRON_RPC_RESPONSE_CHANNEL, {
      clientId: 7,
      data: JSON.stringify(response)
    })
    expect(electronMocks.removeListener).toHaveBeenCalledOnce()
    expect(removeWebContentsListener).toHaveBeenCalledOnce()
  })

  it('ignores malformed inner messages without allocating a client connection', async () => {
    const sender = {
      id: 43,
      isDestroyed: () => false,
      once: vi.fn(),
      removeListener: vi.fn(),
      send: vi.fn()
    }
    const TestProtocol = ElectronRpcServerProtocolLive.pipe(
      Layer.provide(RpcSerialization.layerJson)
    )
    const program = Effect.gen(function*() {
      const protocol = yield* RpcServer.Protocol
      yield* Effect.forkScoped(protocol.run(() => Effect.void))
      const receive = electronMocks.on.mock.calls[0]?.[1] as (
        event: { sender: typeof sender },
        frame: unknown
      ) => void

      receive(
        { sender },
        { clientId: 8, data: JSON.stringify({ _tag: 'Ack' }) }
      )
      yield* Effect.yieldNow
      return yield* protocol.clientIds
    }).pipe(Effect.provide(TestProtocol), Effect.scoped)

    await expect(Effect.runPromise(program)).resolves.toEqual(new Set())
    expect(sender.once).not.toHaveBeenCalled()
  })

  it('processes request and control frames in arrival order', async () => {
    const sender = {
      id: 44,
      isDestroyed: () => false,
      once: vi.fn(),
      removeListener: vi.fn(),
      send: vi.fn()
    }
    const TestProtocol = ElectronRpcServerProtocolLive.pipe(
      Layer.provide(RpcSerialization.layerJson)
    )
    const request = (id: number): RpcMessage.FromClientEncoded => ({
      _tag: 'Request',
      id,
      tag: 'system.getInfo',
      payload: undefined,
      headers: []
    })
    const program = Effect.gen(function*() {
      const protocol = yield* RpcServer.Protocol
      const firstStarted = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const secondReceived = yield* Deferred.make<void>()
      yield* Effect.forkScoped(
        protocol.run((_clientId, message) => {
          if (message._tag !== 'Request') {
            return Effect.void
          }
          return message.id === 1
            ? Deferred.succeed(firstStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFirst)),
                Effect.asVoid
              )
            : Deferred.succeed(secondReceived, undefined).pipe(Effect.asVoid)
        })
      )
      const receive = electronMocks.on.mock.calls[0]?.[1] as (
        event: { sender: typeof sender },
        frame: unknown
      ) => void

      receive({ sender }, { clientId: 9, data: JSON.stringify(request(1)) })
      receive({ sender }, { clientId: 9, data: JSON.stringify(request(2)) })
      yield* Deferred.await(firstStarted)
      const overtookFirst = yield* Deferred.isDone(secondReceived)
      yield* Deferred.succeed(releaseFirst, undefined)
      yield* Deferred.await(secondReceived)
      return overtookFirst
    }).pipe(Effect.provide(TestProtocol), Effect.scoped)

    await expect(Effect.runPromise(program)).resolves.toBe(false)
  })
})
