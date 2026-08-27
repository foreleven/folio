import { Deferred, Effect, Layer } from 'effect'
import {
  RpcMessage,
  RpcSerialization,
  RpcServer
} from 'effect/unstable/rpc'
import { describe, expect, it, vi } from 'vitest'
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
          Deferred.succeed(received, [clientId, message]).pipe(Effect.asVoid)
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

      return { receivedRequest, clientIds: yield* protocol.clientIds }
    }).pipe(Effect.provide(TestProtocol), Effect.scoped)

    await expect(Effect.runPromise(program)).resolves.toEqual({
      receivedRequest: request,
      clientIds: new Set([0])
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
})
