import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SystemRpcHandler } from '../../../shared/handlers/system-rpc-handler'
import { createRendererContainer } from './container'

const request = vi.fn()

beforeEach(() => {
  request.mockReset()
  vi.stubGlobal('window', { desktop: { request } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('renderer dependency container', () => {
  it('injects one system RPC handler implemented by the generic proxy', async () => {
    request.mockResolvedValue({ platform: 'darwin', version: '0.1.0' })
    const container = createRendererContainer()

    const firstHandler = container.get<SystemRpcHandler>(SystemRpcHandler)
    const secondHandler = container.get<SystemRpcHandler>(SystemRpcHandler)

    expect(firstHandler).toBe(secondHandler)
    expect(SystemRpcHandler).toBe(Symbol.for('folio.rpc.SystemRpcHandler'))
    await expect(firstHandler.getInfo()).resolves.toEqual({
      platform: 'darwin',
      version: '0.1.0'
    })
    expect(request).toHaveBeenCalledWith('system.getInfo')
  })
})
