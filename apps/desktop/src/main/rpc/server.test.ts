import { afterEach, describe, expect, it, vi } from 'vitest'
import { JsonRpcError } from './errors'
import type { JsonRpcMethodHandler } from './handler'
import { JsonRpcServer } from './server'

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
  it('dispatches a valid request and preserves its id', async () => {
    const handler: JsonRpcMethodHandler = {
      method: 'example.echo',
      handle: vi.fn((params) => params)
    }
    const server = new JsonRpcServer([handler])

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
    const server = new JsonRpcServer([])

    expect(decode(await server.handleMessage(request))).toEqual({
      jsonrpc: '2.0',
      error: { code, message },
      id: request === '{' || request.includes('"jsonrpc"') === false ? null : 1
    })
  })

  it('serializes deliberate handler errors without treating them as internal failures', async () => {
    const server = new JsonRpcServer([
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
    const server = new JsonRpcServer([{ method: 'example.notify', handle }])

    const response = await server.handleMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'example.notify', params: ['updated'] })
    )

    expect(response).toBeUndefined()
    expect(handle).toHaveBeenCalledWith(['updated'])
  })

  it('handles batches and omits notification responses', async () => {
    const server = new JsonRpcServer([
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
    const server = new JsonRpcServer([
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
    const server = new JsonRpcServer([
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
    const server = new JsonRpcServer([
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

  it('rejects duplicate method registrations', () => {
    const handler: JsonRpcMethodHandler = { method: 'duplicate', handle: () => null }
    expect(() => new JsonRpcServer([handler, handler])).toThrow('JSON-RPC methods must be unique')
  })
})
