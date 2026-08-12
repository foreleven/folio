import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopRpcClient } from '../shared/rpc'
import { RPC_CHANNEL } from '../shared/rpc'

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
  ipcRenderer: { invoke: electronMocks.invoke }
}))

/** Reloads preload so every test starts with request id 1 and a fresh exposed client. */
async function loadPreload(): Promise<{
  client: DesktopRpcClient
  RpcClientError: typeof import('./index')['RpcClientError']
}> {
  vi.resetModules()
  const module = await import('./index')
  const client = electronMocks.exposeInMainWorld.mock.calls[0]?.[1] as DesktopRpcClient
  return { client, RpcClientError: module.RpcClientError }
}

beforeEach(() => {
  electronMocks.exposeInMainWorld.mockReset()
  electronMocks.invoke.mockReset()
})

describe('preload RPC client', () => {
  it('serializes a typed request and returns its result', async () => {
    electronMocks.invoke.mockResolvedValue(
      JSON.stringify({ jsonrpc: '2.0', result: { platform: 'darwin', version: '0.1.0' }, id: 1 })
    )
    const { client } = await loadPreload()

    await expect(client.request('system.getInfo')).resolves.toEqual({
      platform: 'darwin',
      version: '0.1.0'
    })
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      RPC_CHANNEL,
      JSON.stringify({ jsonrpc: '2.0', method: 'system.getInfo', id: 1 })
    )
  })

  it('maps a JSON-RPC failure to RpcClientError', async () => {
    electronMocks.invoke.mockResolvedValue(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal error', data: { traceId: 'safe-id' } },
        id: 1
      })
    )
    const { client, RpcClientError } = await loadPreload()

    const request = client.request('system.getInfo')
    await expect(request).rejects.toBeInstanceOf(RpcClientError)
    await expect(request).rejects.toMatchObject({
      code: -32603,
      message: 'Internal error',
      data: { traceId: 'safe-id' }
    })
  })

  it.each([
    ['non-string response', { jsonrpc: '2.0', result: {}, id: 1 }],
    ['invalid JSON', '{'],
    ['mismatched id', JSON.stringify({ jsonrpc: '2.0', result: {}, id: 99 })],
    ['invalid envelope', JSON.stringify({ jsonrpc: '2.0', id: 1 })]
  ])('rejects a %s', async (_name, response) => {
    electronMocks.invoke.mockResolvedValue(response)
    const { client, RpcClientError } = await loadPreload()

    await expect(client.request('system.getInfo')).rejects.toEqual(
      new RpcClientError(-32000, 'Invalid response from main process')
    )
  })
})
