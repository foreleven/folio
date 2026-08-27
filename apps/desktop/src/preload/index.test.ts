import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ELECTRON_RPC_REQUEST_CHANNEL,
  ELECTRON_RPC_RESPONSE_CHANNEL,
  type ElectronRpcBridge,
  type ElectronRpcFrame
} from '../shared/rpc/electron-rpc'

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  on: vi.fn(),
  send: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
  ipcRenderer: { on: electronMocks.on, send: electronMocks.send }
}))

/** Reloads preload and returns the bridge exposed through context isolation. */
async function loadPreload(): Promise<{
  bridge: ElectronRpcBridge
  receive: (frame: ElectronRpcFrame) => void
}> {
  vi.resetModules()
  await import('./index')
  const bridge = electronMocks.exposeInMainWorld.mock.calls[0]?.[1] as ElectronRpcBridge
  const receive = electronMocks.on.mock.calls[0]?.[1] as (
    event: unknown,
    frame: ElectronRpcFrame
  ) => void
  return { bridge, receive: (frame) => receive(undefined, frame) }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('preload Electron RPC bridge', () => {
  it('forwards serialized client frames without exposing Electron primitives', async () => {
    const { bridge } = await loadPreload()
    const frame = { clientId: 3, data: '{"_tag":"Request"}' }

    bridge.send(frame)

    expect(electronMocks.send).toHaveBeenCalledWith(ELECTRON_RPC_REQUEST_CHANNEL, frame)
    expect(electronMocks.on).toHaveBeenCalledWith(
      ELECTRON_RPC_RESPONSE_CHANNEL,
      expect.any(Function)
    )
  })

  it('delivers valid server frames only while a listener is installed', async () => {
    const { bridge, receive } = await loadPreload()
    const listener = vi.fn()
    const frame = { clientId: 7, data: '{"_tag":"Exit"}' }

    bridge.listen(listener)
    receive(frame)
    receive({ clientId: Number.NaN, data: 'invalid' })
    bridge.clearListener()
    receive(frame)

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith(frame)
  })
})
