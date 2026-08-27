import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SystemService } from '../../../shared/services/system-service'
import { createRendererContainer, getSystemService } from './container'

const request = vi.fn()

beforeEach(() => {
  request.mockReset()
  vi.stubGlobal('window', { desktop: { request } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('renderer dependency container', () => {
  it('injects one system service implemented by the RPC proxy', async () => {
    request.mockResolvedValue({ platform: 'darwin', version: '0.1.0' })
    const container = createRendererContainer()

    const firstService = getSystemService(container)
    const secondService = getSystemService(container)

    expect(firstService).toBe(secondService)
    expect(SystemService).toBe(Symbol.for('folio.services.SystemService'))
    await expect(firstService.getInfo()).resolves.toEqual({
      platform: 'darwin',
      version: '0.1.0'
    })
    expect(request).toHaveBeenCalledWith('system.getInfo')
  })
})
