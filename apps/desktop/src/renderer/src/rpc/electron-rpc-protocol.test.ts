import { Deferred, Effect, Layer } from 'effect'
import {
  RpcClient,
  RpcMessage,
  RpcSerialization
} from 'effect/unstable/rpc'
import { describe, expect, it } from 'vitest'
import type {
  ElectronRpcBridge,
  ElectronRpcFrame
} from '../../../shared/rpc/electron-rpc'
import {
  ElectronRpcBridgeService,
  ElectronRpcClientProtocolLive
} from './electron-rpc-protocol'

describe('Electron Effect RPC client protocol', () => {
  it('serializes requests and routes decoded responses to the originating client', async () => {
    const sent: Array<ElectronRpcFrame> = []
    let listener: ((frame: ElectronRpcFrame) => void) | undefined
    const bridge: ElectronRpcBridge = {
      send: (frame) => sent.push(frame),
      listen: (nextListener) => {
        listener = nextListener
      },
      clearListener: () => {
        listener = undefined
      }
    }
    const TestBridge = Layer.succeed(ElectronRpcBridgeService)(bridge)
    const TestProtocol = ElectronRpcClientProtocolLive.pipe(
      Layer.provide(TestBridge),
      Layer.provide(RpcSerialization.layerJson)
    )
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
    const program = Effect.gen(function*() {
      const protocol = yield* RpcClient.Protocol
      const received = yield* Deferred.make<RpcMessage.FromServerEncoded>()
      yield* Effect.forkScoped(
        protocol.run(9, (message) => Deferred.succeed(received, message).pipe(Effect.asVoid))
      )

      yield* protocol.send(9, request)
      listener?.({ clientId: 9, data: JSON.stringify(response) })

      return yield* Deferred.await(received)
    }).pipe(Effect.provide(TestProtocol), Effect.scoped)

    await expect(Effect.runPromise(program)).resolves.toEqual(response)
    expect(sent).toEqual([{ clientId: 9, data: JSON.stringify(request) }])
    expect(listener).toBeUndefined()
  })
})
