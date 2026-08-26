import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JsonRpcParams } from '../../shared/rpc'
import { JsonRpcError } from './errors'
import { JsonRpcServer } from './server'

interface TestRpcMethod {
  method: string
  handle(params: JsonRpcParams | undefined): unknown
}

/** Builds namespace objects from concise method fixtures used by protocol tests. */
function createServer(methods: readonly TestRpcMethod[] = []): JsonRpcServer {
  const server = new JsonRpcServer()
  const namespaces = new Map<string, Record<string, TestRpcMethod['handle']>>()

  for (const method of methods) {
    const separator = method.method.lastIndexOf('.')
    const namespace = method.method.slice(0, separator)
    const methodName = method.method.slice(separator + 1)
    const handler = namespaces.get(namespace) ?? {}
    handler[methodName] = method.handle
    namespaces.set(namespace, handler)
  }

  for (const [namespace, handler] of namespaces) {
    server.register(namespace, handler)
  }

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
  it('registers every public method on one namespace handler', async () => {
    class ExampleRpcHandler {
      private readonly readiness = 'ready'

      /** Echoes the request params to prove namespace dispatch. */
      public echo(params: unknown): unknown {
        return params
      }

      /** Returns a second result from the same registered handler instance. */
      public status(): string {
        return this.readiness
      }
    }

    const server = new JsonRpcServer()
    server.register('example', new ExampleRpcHandler())

    await expect(
      server.handleMessage(
        JSON.stringify({ jsonrpc: '2.0', method: 'example.echo', params: { value: 7 }, id: 1 })
      )
    ).resolves.toBe(JSON.stringify({ jsonrpc: '2.0', result: { value: 7 }, id: 1 }))
    await expect(
      server.handleMessage(
        JSON.stringify({ jsonrpc: '2.0', method: 'example.status', id: 2 })
      )
    ).resolves.toBe(JSON.stringify({ jsonrpc: '2.0', result: 'ready', id: 2 }))
  })

  it('does not expose inherited Object methods as RPC methods', async () => {
    const server = createServer([{ method: 'example.echo', handle: (params) => params }])

    expect(
      decode(
        await server.handleMessage(
          JSON.stringify({ jsonrpc: '2.0', method: 'example.toString', id: 1 })
        )
      )
    ).toEqual({
      jsonrpc: '2.0',
      error: { code: -32601, message: 'Method not found' },
      id: 1
    })
  })

  it('dispatches a valid request and preserves its id', async () => {
    const handler: TestRpcMethod = {
      method: 'example.echo',
      handle: vi.fn((params) => params)
    }
    const server = createServer([handler])

    const response = await server.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'example.echo', params: { value: 7 }, id: 42 })
    )

    expect(decode(response)).toEqual({
      jsonrpc: '2.0',
      result: { value: 7 },
      id: 42
    })
  })

  it.each([
    ['invalid JSON', '{', -32700, 'Parse error'],
    ['invalid envelope', JSON.stringify({ method: 'example.echo', id: 1 }), -32600, 'Invalid Request'],
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
    const server = createServer([
      {
        method: 'example.fail',
        handle: () => {
          throw new JsonRpcError(-32602, 'Invalid params', { field: 'name' })
        }
      }
    ])

    const response = await server.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'example.fail', id: 'request-1' })
    )

    expect(decode(response)).toEqual({
      jsonrpc: '2.0',
      error: { code: -32602, message: 'Invalid params', data: { field: 'name' } },
      id: 'request-1'
    })
  })

  it('executes a notification without returning a response', async () => {
    const handle = vi.fn(() => undefined)
    const server = createServer([{ method: 'example.notify', handle }])

    const response = await server.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'example.notify', params: ['updated'] })
    )

    expect(response).toBeUndefined()
    expect(handle).toHaveBeenCalledWith(['updated'])
  })

  it('handles batches and omits notification responses', async () => {
    const server = createServer([
      { method: 'example.echo', handle: (params) => params },
      { method: 'example.notify', handle: () => undefined }
    ])

    const response = await server.handleMessage(
      JSON.stringify([
        { jsonrpc: '2.0', method: 'example.echo', params: [1], id: 1 },
        { jsonrpc: '2.0', method: 'example.notify' },
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
    const server = createServer([
      { method: 'example.bigint', handle: () => 1n }
    ])

    const response = await server.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'example.bigint', id: 3 })
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
    const server = createServer([
      { method: 'example.symbol', handle: () => Symbol('not-json') }
    ])

    const response = await server.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'example.symbol', id: 4 })
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
    const server = createServer([
      {
        method: 'example.crash',
        handle: () => {
          throw new Error('database password leaked')
        }
      }
    ])

    const response = await server.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'example.crash', id: 9 })
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
    server.register('duplicate', { first: () => null })

    expect(() => server.register('duplicate', { second: () => null })).toThrow(
      'JSON-RPC namespace "duplicate" is already registered'
    )
  })
})
