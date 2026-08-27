import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopRpcProxy } from './rpc-proxy'

const request = vi.fn()

beforeEach(() => {
  request.mockReset()
  vi.stubGlobal('window', { desktop: { request } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DesktopRpcProxy', () => {
  it('forwards one params argument through the registered service route', async () => {
    request.mockResolvedValue({ platform: 'darwin', version: '0.1.0' })
    const service = new DesktopRpcProxy().getService('system')
    const getInfo = service.getInfo as unknown as (params: unknown) => Promise<unknown>

    await expect(getInfo({ refresh: true })).resolves.toEqual({
      platform: 'darwin',
      version: '0.1.0'
    })
    expect(request).toHaveBeenCalledWith('system.getInfo', { refresh: true })
  })

  it('rejects calls with more than one params argument before transport', async () => {
    const service = new DesktopRpcProxy().getService('system')
    const getInfo = service.getInfo as unknown as (...args: unknown[]) => Promise<unknown>

    await expect(getInfo('first', 'second')).rejects.toThrow(
      'RPC service methods accept at most one params argument'
    )
    expect(request).not.toHaveBeenCalled()
  })

  it('does not expose then or symbol properties as remote methods', () => {
    const service = new DesktopRpcProxy().getService('system') as unknown as Record<
      PropertyKey,
      unknown
    >

    expect(service.then).toBeUndefined()
    expect(service[Symbol.toStringTag]).toBeUndefined()
    expect(request).not.toHaveBeenCalled()
  })
})
