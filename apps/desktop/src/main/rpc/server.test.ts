import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JsonRpcParams, SystemInfo } from '../../shared/rpc'
import { JsonRpcError } from './errors'
import { JsonRpcServer } from './server'

type TestRpcMethod = (params: JsonRpcParams | undefined) => unknown

/** Registers a controllable system method for focused protocol tests. */
function createServer(handle: TestRpcMethod = () => null): JsonRpcServer {
  const server = new JsonRpcServer()
  server.register('system', {
    // Protocol failure tests deliberately return values outside the production result type.
    getInfo: (params: undefined) => handle(params) as SystemInfo
  })

  return server
}

/** Decodes a server response for focused protocol assertions. */
function decode(message: string | undefined): unknown {
  if (message === undefined) {
    return undefined
  }
  return JSON.parse(message)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('JsonRpcServer', () => {
  it('registers contract methods, preserves this, and keeps helpers private', async () => {
    class TestSystemRpcHandler {
      private readonly readiness = 'ready'

      /** Returns a contract-valid response while reading instance state. */
      public getInfo(): SystemInfo {
        return { platform: process.platform, version: this.readiness }
      }

      /** Represents process-only behavior that must not become remotely callable. */
      public helper(): string {
        return this.readiness
      }
    }

    const server = new JsonRpcServer()
    server.register('system', new TestSystemRpcHandler())

    await expect(
      server.handleMessage(
        JSON.stringify({ jsonrpc: '2.0', method: 'system.getInfo', id: 1 })
      )
    ).resolves.toBe(
      JSON.stringify({
        jsonrpc: '2.0',
        result: { platform: process.platform, version: 'ready' },
        id: 1
      })
    )

    expect(
      decode(
        await server.handleMessage(
          JSON.stringify({ jsonrpc: '2.0', method: 'system.helper', id: 2 })
        )
      )
    ).toEqual({
      jsonrpc: '2.0',
      error: { code: -32601, message: 'Method not found' },
      id: 2
    })
  })

  it('does not expose inherited Object methods as RPC methods', async () => {
    const server = createServer()

    expect(
      decode(
        await server.handleMessage(
          JSON.stringify({ jsonrpc: '2.0', method: 'system.toString', id: 1 })
        )
      )
    ).toEqual({
      jsonrpc: '2.0',
      error: { code: -32601, message: 'Method not found' },
      id: 1
    })
  })

  it('dispatches a valid request and preserves its id', async () => {
    const handle = vi.fn((params) => params)
    const server = createServer(handle)

    const response = await server.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'system.getInfo', params: { value: 7 }, id: 42 })
    )

    expect(decode(response)).toEqual({
      jsonrpc: '2.0',
      result: { value: 7 },
      id: 42
    })
  })

  it.each([
    ['invalid JSON', '{', -32700, 'Parse error'],
    ['invalid envelope', JSON.stringify({ method: 'system.getInfo', id: 1 }), -32600, 'Invalid Request'],
    [
      'unknown method',
      JSON.stringify({ jsonrpc: '2.0', method: 'missing', id: 1 }),
      -32601,
      'Method not found'
    ]
  ])('returns a standard error for %s', async (_name, request, code, message) => {
    const server = createServer()

    expect(decode(await server.handleMessage(request))).toEqual({
      jsonrpc: '2.0',
      error: { code, message },
      id: request === '{' || request.includes('"jsonrpc"') === false ? null : 1
    })
  })

  it('serializes deliberate handler errors without treating them as internal failures', async () => {
    const server = createServer(() => {
      throw new JsonRpcError(-32602, 'Invalid params', { field: 'name' })
    })

    const response = await server.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'system.getInfo', id: 'request-1' })
    )

    expect(decode(response)).toEqual({
      jsonrpc: '2.0',
      error: { code: -32602, message: 'Invalid params', data: { field: 'name' } },
      id: 'request-1'
    })
  })

  it('executes a notification without returning a response', async () => {
    const handle = vi.fn(() => undefined)
    const server = createServer(handle)

    const response = await server.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'system.getInfo', params: ['updated'] })
    )

    expect(response).toBeUndefined()
    expect(handle).toHaveBeenCalledWith(['updated'])
  })

  it('handles batches and omits notification responses', async () => {
    const server = createServer((params) => params)

    const response = await server.handleMessage(
      JSON.stringify([
        { jsonrpc: '2.0', method: 'system.getInfo', params: [1], id: 1 },
        { jsonrpc: '2.0', method: 'system.getInfo' },
        { jsonrpc: '2.0', method: 'missing', id: 2 },
        false
      ])
    )

    expect(decode(response)).toEqual([
      { jsonrpc: '2.0', result: [1], id: 1 },
      { jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' }, id: 2 },
      { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id: null }
    ])
  })

  it('returns an internal error when a handler result cannot be serialized', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const server = createServer(() => 1n)

    const response = await server.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'system.getInfo', id: 3 })
    )

    expect(decode(response)).toEqual({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal error' },
      id: 3
    })
    expect(consoleError).toHaveBeenCalledOnce()
  })

  it('rejects values whose result field disappears during serialization', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const server = createServer(() => Symbol('not-json'))

    const response = await server.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'system.getInfo', id: 4 })
    )

    expect(decode(response)).toEqual({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal error' },
      id: 4
    })
    expect(consoleError).toHaveBeenCalledOnce()
  })

  it('hides unexpected exception details', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const server = createServer(() => {
      throw new Error('database password leaked')
    })

    const response = await server.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'system.getInfo', id: 9 })
    )

    expect(decode(response)).toEqual({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal error' },
      id: 9
    })
    expect(consoleError).toHaveBeenCalledOnce()
  })

  it('rejects duplicate namespace registrations', () => {
    const server = new JsonRpcServer()
    const handler = { getInfo: () => ({ platform: process.platform, version: 'test' }) }
    server.register('system', handler)

    expect(() => server.register('system', handler)).toThrow(
      'JSON-RPC namespace "system" is already registered'
    )
  })
})
