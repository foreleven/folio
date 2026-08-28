import * as AtomRegistry from 'effect/unstable/reactivity/AtomRegistry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ElectronRpcBridge,
  ElectronRpcFrame
} from '../../shared/rpc/electron-rpc'
import {
  requestSystemInfoAtom
} from './atoms/system-info'
import { SystemRpcClient } from './rpc/system-rpc'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('renderer Effect atoms', () => {
  it('loads system info through the throttled request atom', async () => {
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

    const registry = AtomRegistry.make()
    const releaseQuery = registry.mount(SystemRpcClient.getSystemInfo)
    const releaseRequests = registry.mount(requestSystemInfoAtom)

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

    await vi.waitFor(() =>
      expect(registry.get(SystemRpcClient.getSystemInfo)).toMatchObject({
        _tag: 'Success',
        value: { platform: 'darwin', version: '1.2.3' },
        waiting: false
      })
    )

    registry.set(requestSystemInfoAtom, undefined)
    registry.set(requestSystemInfoAtom, undefined)
    registry.set(requestSystemInfoAtom, undefined)
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    const refreshedRequest = sent[1]
    const refreshedMessage = JSON.parse(refreshedRequest.data) as { readonly id: string | number }
    listener?.({
      clientId: refreshedRequest.clientId,
      data: JSON.stringify({
        _tag: 'Exit',
        requestId: refreshedMessage.id,
        exit: {
          _tag: 'Success',
          value: { platform: 'darwin', version: '1.2.4' }
        }
      })
    })

    await vi.waitFor(() =>
      expect(registry.get(SystemRpcClient.getSystemInfo)).toMatchObject({
        _tag: 'Success',
        value: { platform: 'darwin', version: '1.2.4' },
        waiting: false
      })
    )

    // The click burst refreshes the query only once.
    expect(sent).toHaveLength(2)

    // Once the one-second window expires, the next refresh is allowed through.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    registry.set(requestSystemInfoAtom, undefined)
    await vi.waitFor(() => expect(sent).toHaveLength(3))
    const nextRequest = sent[2]
    const nextMessage = JSON.parse(nextRequest.data) as { readonly id: string | number }
    listener?.({
      clientId: nextRequest.clientId,
      data: JSON.stringify({
        _tag: 'Exit',
        requestId: nextMessage.id,
        exit: {
          _tag: 'Failure',
          cause: [{ _tag: 'Fail', error: { message: 'system unavailable' } }]
        }
      })
    })

    await vi.waitFor(() =>
      expect(registry.get(SystemRpcClient.getSystemInfo)).toMatchObject({
        _tag: 'Failure',
        waiting: false
      })
    )

    releaseRequests()
    releaseQuery()
    registry.dispose()
    expect(listener).toBeUndefined()
  })
})
