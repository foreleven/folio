import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopRpcProxy } from './rpc-proxy'

const request = vi.fn()

interface ExampleRpcHandler {
  getInfo(params?: unknown): Promise<unknown>
}

beforeEach(() => {
  request.mockReset()
  vi.stubGlobal('window', { desktop: { request } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DesktopRpcProxy', () => {
  it('forwards one params argument through a generic namespace client', async () => {
    request.mockResolvedValue({ platform: 'darwin', version: '0.1.0' })
    const client = new DesktopRpcProxy().createClient<ExampleRpcHandler>('example')

    await expect(client.getInfo({ refresh: true })).resolves.toEqual({
      platform: 'darwin',
      version: '0.1.0'
    })
    expect(request).toHaveBeenCalledWith('example.getInfo', { refresh: true })
  })

  it('rejects calls with more than one params argument before transport', async () => {
    const client = new DesktopRpcProxy().createClient<ExampleRpcHandler>('example')
    const getInfo = client.getInfo as (...args: unknown[]) => Promise<unknown>

    await expect(getInfo('first', 'second')).rejects.toThrow(
      'RPC service methods accept at most one params argument'
    )
    expect(request).not.toHaveBeenCalled()
  })

  it('does not expose then or symbol properties as remote methods', () => {
    const client = new DesktopRpcProxy().createClient<ExampleRpcHandler>(
      'example'
    ) as unknown as Record<
      PropertyKey,
      unknown
    >

    expect(client.then).toBeUndefined()
    expect(client[Symbol.toStringTag]).toBeUndefined()
    expect(request).not.toHaveBeenCalled()
  })
})
