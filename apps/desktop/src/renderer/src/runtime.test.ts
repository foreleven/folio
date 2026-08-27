import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SystemRpcClient } from '../../shared/rpc/system-rpc'
import type {
  ElectronRpcBridge,
  ElectronRpcFrame
} from '../../shared/rpc/electron-rpc'
import { createRendererRuntime } from './runtime'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('renderer Effect runtime', () => {
  it('provides the generated system client through the Electron RPC protocol', async () => {
    const sent: Array<ElectronRpcFrame> = []
    let listener: ((frame: ElectronRpcFrame) => void) | undefined
    const bridge: ElectronRpcBridge = {
      send: (frame) => sent.push(frame),
      listen: (nextListener) => {
        listener = nextListener
      },
      clearListener: () => {
        listener = undefined
      }
    }
    vi.stubGlobal('window', { desktopRpc: bridge })
    const runtime = createRendererRuntime()
    const request = runtime.runPromise(
      Effect.gen(function*() {
        const client = yield* SystemRpcClient
        return yield* client['system.getInfo']()
      })
    )

    await vi.waitFor(() => expect(sent).toHaveLength(1))
    const frame = sent[0]
    const message = JSON.parse(frame.data) as { readonly id: string | number }
    listener?.({
      clientId: frame.clientId,
      data: JSON.stringify({
        _tag: 'Exit',
        requestId: message.id,
        exit: {
          _tag: 'Success',
          value: { platform: 'darwin', version: '1.2.3' }
        }
      })
    })

    await expect(request).resolves.toEqual({ platform: 'darwin', version: '1.2.3' })
    await runtime.dispose()
    expect(listener).toBeUndefined()
  })
})
