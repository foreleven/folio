import { Deferred, Effect, Layer, ManagedRuntime, Schema, Stream } from 'effect'
import { EventEmitter } from 'node:events'
import {
  RpcMessage,
  Rpc,
  RpcGroup,
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
  it.each([0, 1])('delivers a new stream snapshot after the same WebContents reloads and reuses request IDs (client %i)', async (nextClientId) => {
    let activeSubscriptions = 0
    const Rpcs = RpcGroup.make(Rpc.make('watch', { success: Schema.String, stream: true }))
    const runtime = ManagedRuntime.make(RpcServer.layer(Rpcs).pipe(
      Layer.provide(Rpcs.toLayerHandler('watch', () => Stream.unwrap(Effect.sync(() => {
        activeSubscriptions++
        return Stream.concat(Stream.make('snapshot'), Stream.never).pipe(
          Stream.ensuring(Effect.sync(() => { activeSubscriptions-- }))
        )
      })))),
      Layer.provide(ElectronRpcServerProtocolLive),
      Layer.provide(RpcSerialization.layerJson)
    ))
    const sender = Object.assign(new EventEmitter(), {
      id: 45, isDestroyed: () => false, send: vi.fn()
    })
    const otherWindow = Object.assign(new EventEmitter(), {
      id: 46, isDestroyed: () => false, send: vi.fn()
    })
    try {
      await runtime.runPromise(Effect.void)
      const receive = electronMocks.on.mock.calls[0][1]
      const request = { clientId: 0, data: JSON.stringify({
        _tag: 'Request', id: 0, tag: 'watch', payload: null, headers: []
      }) }
      receive({ sender }, request)
      await vi.waitFor(() => expect(sender.send).toHaveBeenCalledWith(
        ELECTRON_RPC_RESPONSE_CHANNEL,
        { clientId: 0, data: JSON.stringify({ _tag: 'Chunk', requestId: 0, values: ['snapshot'] }) }
      ))
      receive({ sender }, { clientId: 0, data: JSON.stringify({ _tag: 'Ack', requestId: 0 }) })
      receive({ sender: otherWindow }, request)
      await vi.waitFor(() => expect(otherWindow.send).toHaveBeenCalled())

      // In-place routes and subframe navigation keep the existing subscriptions.
      for (const details of [
        { isMainFrame: true, isSameDocument: true },
        { isMainFrame: false, isSameDocument: false }
      ]) {
        sender.emit('did-start-navigation', details)
        sender.send.mockClear()
        receive({ sender }, { clientId: 0, data: JSON.stringify({ _tag: 'Ping' }) })
        await vi.waitFor(() => expect(sender.send).toHaveBeenCalledWith(
          ELECTRON_RPC_RESPONSE_CHANNEL, { clientId: 0, data: JSON.stringify({ _tag: 'Pong' }) }
        ))
        expect(activeSubscriptions).toBe(2)
      }

      // Vite can replace an RPC module before requesting a full page reload.
      // A rejected duplicate must not kill the shared IPC consumer in that gap.
      receive({ sender }, request)
      await new Promise<void>((resolve) => setImmediate(resolve))

      // Reload destroys the JS runtime, not WebContents; its finalizers cannot
      // send Eof and the new runtime starts client/request counters at zero.
      for (let reload = 0; reload < 3; reload++) {
        sender.send.mockClear()
        sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
        receive({ sender }, { ...request, clientId: nextClientId })
        await vi.waitFor(() => expect(sender.send).toHaveBeenCalledWith(
          ELECTRON_RPC_RESPONSE_CHANNEL,
          { clientId: nextClientId, data: JSON.stringify({ _tag: 'Chunk', requestId: 0, values: ['snapshot'] }) }
        ), { timeout: 500 })
        expect(sender.send).toHaveBeenCalledTimes(1)
        // Later reloads interrupt streams awaiting Ack, and never accumulate subscriptions.
        expect(activeSubscriptions).toBe(2)
      }
      otherWindow.send.mockClear()
      receive({ sender: otherWindow }, { clientId: 0, data: JSON.stringify({ _tag: 'Ping' }) })
      await vi.waitFor(() => expect(otherWindow.send).toHaveBeenCalledWith(
        ELECTRON_RPC_RESPONSE_CHANNEL, { clientId: 0, data: JSON.stringify({ _tag: 'Pong' }) }
      ))
    } finally { await runtime.dispose() }
    expect(activeSubscriptions).toBe(0)
    expect(sender.eventNames()).toEqual([])
    expect(otherWindow.eventNames()).toEqual([])
  })

  it.each(['did-start-navigation', 'render-process-gone', 'destroyed'])(
    'drops old queued frames after %s without blocking another window', async (event) => {
      let destroyed = false
      const sender = Object.assign(new EventEmitter(), { id: 47, isDestroyed: () => destroyed, send: vi.fn() })
      const other = Object.assign(new EventEmitter(), { id: 48, isDestroyed: () => false, send: vi.fn() })
      const received: Array<string> = []
      const TestProtocol = ElectronRpcServerProtocolLive.pipe(Layer.provide(RpcSerialization.layerJson))
      await Effect.runPromise(Effect.gen(function*() {
        const protocol = yield* RpcServer.Protocol
        const barrier = yield* Deferred.make<void>()
        yield* Effect.forkScoped(protocol.run((_clientId, message) => {
          if (message._tag !== 'Request') return Effect.void
          received.push(message.tag)
          return message.tag === 'barrier' ? Deferred.succeed(barrier, undefined).pipe(Effect.asVoid) : Effect.void
        }))
        const receive = electronMocks.on.mock.calls[0][1]
        const frame = (tag: string) => ({ clientId: 0, data: JSON.stringify({
          _tag: 'Request', id: 0, tag, payload: null, headers: []
        }) })
        // Queue a request and destroy its document before the consumer gets a turn.
        receive({ sender }, frame('stale'))
        destroyed = event === 'destroyed'
        sender.emit(event, { isMainFrame: true, isSameDocument: false })
        if (destroyed) receive({ sender }, frame('after-destroy'))
        receive({ sender: other }, frame('barrier'))
        yield* Deferred.await(barrier)
        expect(received).toEqual(['barrier'])
        expect((yield* protocol.clientIds).size).toBe(1)
        expect(sender.send).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestProtocol), Effect.scoped))
      expect(sender.eventNames()).toEqual([])
      expect(other.eventNames()).toEqual([])
    }
  )

  it('routes renderer frames through an isolated server client connection', async () => {
    const send = vi.fn()
    const once = vi.fn()
    const removeWebContentsListener = vi.fn()
    const sender = {
      id: 42,
      isDestroyed: () => false,
      once,
      on: vi.fn(),
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
      const ended = yield* Deferred.make<void>()
      const received = yield* Deferred.make<
        readonly [number, RpcMessage.FromClientEncoded]
      >()
      yield* Effect.forkScoped(
        protocol.run((clientId, message) =>
          message._tag === 'Eof'
            ? protocol.end(clientId).pipe(Effect.andThen(Deferred.succeed(ended, undefined)))
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
      yield* Deferred.await(ended)
      expect(removeWebContentsListener).not.toHaveBeenCalled()

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
    expect(removeWebContentsListener).toHaveBeenCalledTimes(3)
  })

  it('ignores malformed inner messages without allocating a client connection', async () => {
    const sender = {
      id: 43,
      isDestroyed: () => false,
      once: vi.fn(),
      on: vi.fn(),
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
    expect(sender.send).not.toHaveBeenCalled()
    expect(sender.removeListener).toHaveBeenCalledTimes(3)
  })

  it('processes request and control frames in arrival order', async () => {
    const sender = {
      id: 44,
      isDestroyed: () => false,
      once: vi.fn(),
      on: vi.fn(),
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
