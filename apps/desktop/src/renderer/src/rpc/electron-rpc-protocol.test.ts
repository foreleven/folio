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
    expect(sent).toEqual([
      { clientId: 9, data: JSON.stringify(request) },
      { clientId: 9, data: JSON.stringify({ _tag: 'Eof' }) }
    ])
    expect(listener).toBeUndefined()
  })

  it('rejects malformed inner responses instead of routing unsafe data', async () => {
    let listener: ((frame: ElectronRpcFrame) => void) | undefined
    const bridge: ElectronRpcBridge = {
      send: () => undefined,
      listen: (nextListener) => {
        listener = nextListener
      },
      clearListener: () => {
        listener = undefined
      }
    }
    const TestProtocol = ElectronRpcClientProtocolLive.pipe(
      Layer.provide(Layer.succeed(ElectronRpcBridgeService)(bridge)),
      Layer.provide(RpcSerialization.layerJson)
    )
    const program = Effect.gen(function*() {
      const protocol = yield* RpcClient.Protocol
      const received = yield* Deferred.make<RpcMessage.FromServerEncoded>()
      yield* Effect.forkScoped(
        protocol.run(4, (message) => Deferred.succeed(received, message).pipe(Effect.asVoid))
      )

      yield* Effect.yieldNow
      listener?.({ clientId: 4, data: JSON.stringify({ _tag: 'Exit' }) })
      return yield* Deferred.await(received)
    }).pipe(Effect.provide(TestProtocol), Effect.scoped)

    const message = await Effect.runPromise(program)
    expect(message._tag).toBe('ClientProtocolError')
  })

  it('processes responses sequentially for one renderer runtime', async () => {
    let listener: ((frame: ElectronRpcFrame) => void) | undefined
    const bridge: ElectronRpcBridge = {
      send: () => undefined,
      listen: (nextListener) => {
        listener = nextListener
      },
      clearListener: () => {
        listener = undefined
      }
    }
    const TestProtocol = ElectronRpcClientProtocolLive.pipe(
      Layer.provide(Layer.succeed(ElectronRpcBridgeService)(bridge)),
      Layer.provide(RpcSerialization.layerJson)
    )
    const program = Effect.gen(function*() {
      const protocol = yield* RpcClient.Protocol
      const firstStarted = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const secondReceived = yield* Deferred.make<void>()
      yield* Effect.forkScoped(
        protocol.run(5, (message) =>
          message._tag === 'Chunk'
            ? Deferred.succeed(firstStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFirst)),
                Effect.asVoid
              )
            : Deferred.succeed(secondReceived, undefined).pipe(Effect.asVoid)
        )
      )

      yield* Effect.yieldNow
      listener?.({
        clientId: 5,
        data: JSON.stringify({ _tag: 'Chunk', requestId: 1, values: ['first'] })
      })
      listener?.({
        clientId: 5,
        data: JSON.stringify({
          _tag: 'Exit',
          requestId: 1,
          exit: { _tag: 'Success', value: 'done' }
        })
      })
      yield* Deferred.await(firstStarted)
      const overtookFirst = yield* Deferred.isDone(secondReceived)
      yield* Deferred.succeed(releaseFirst, undefined)
      yield* Deferred.await(secondReceived)
      return overtookFirst
    }).pipe(Effect.provide(TestProtocol), Effect.scoped)

    await expect(Effect.runPromise(program)).resolves.toBe(false)
  })
})
