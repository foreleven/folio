import * as Atom from 'effect/unstable/reactivity/Atom'
import * as AtomRegistry from 'effect/unstable/reactivity/AtomRegistry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ElectronRpcBridge,
  ElectronRpcFrame
} from '../../shared/rpc/electron-rpc'
import {
  loadSystemInfoAtom,
  requestSystemInfoAtom,
  systemInfoStateAtom
} from './atoms/system-info'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('renderer Effect atoms', () => {
  it('runs the generated system client through an async action atom', async () => {
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
    const release = registry.mount(loadSystemInfoAtom)
    registry.mount(systemInfoStateAtom)
    const releaseRequests = registry.mount(requestSystemInfoAtom)
    registry.set(requestSystemInfoAtom, undefined)
    registry.set(requestSystemInfoAtom, undefined)
    registry.set(requestSystemInfoAtom, undefined)

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
      expect(registry.get(systemInfoStateAtom)).toEqual({
        _tag: 'Available',
        platform: 'darwin',
        version: '1.2.3'
      })
    )

    // The first burst is throttled to one RPC request.
    expect(sent).toHaveLength(1)

    // Once the one-second window expires, the next click is allowed through.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    registry.set(requestSystemInfoAtom, undefined)
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    const nextRequest = sent[1]
    const nextMessage = JSON.parse(nextRequest.data) as { readonly id: string | number }
    listener?.({
      clientId: nextRequest.clientId,
      data: JSON.stringify({
        _tag: 'Exit',
        requestId: nextMessage.id,
        exit: {
          _tag: 'Success',
          value: { platform: 'darwin', version: '1.2.3' }
        }
      })
    })

    await vi.waitFor(() =>
      expect(registry.get(systemInfoStateAtom)).toEqual({
        _tag: 'Available',
        platform: 'darwin',
        version: '1.2.3'
      })
    )

    registry.set(loadSystemInfoAtom, undefined)
    await vi.waitFor(() => expect(sent).toHaveLength(3))
    const failedRequest = sent[2]
    const failedMessage = JSON.parse(failedRequest.data) as { readonly id: string | number }
    listener?.({
      clientId: failedRequest.clientId,
      data: JSON.stringify({
        _tag: 'Exit',
        requestId: failedMessage.id,
        exit: {
          _tag: 'Failure',
          cause: [{ _tag: 'Fail', error: { message: 'system unavailable' } }]
        }
      })
    })

    await vi.waitFor(() =>
      expect(registry.get(systemInfoStateAtom)).toEqual({ _tag: 'Unavailable' })
    )

    registry.set(loadSystemInfoAtom, undefined)
    await vi.waitFor(() => expect(sent).toHaveLength(4))
    registry.set(loadSystemInfoAtom, Atom.Interrupt)

    await vi.waitFor(() =>
      expect(registry.get(systemInfoStateAtom)).toEqual({ _tag: 'Unavailable' })
    )

    release()
    releaseRequests()
    registry.dispose()
    expect(listener).toBeUndefined()
  })
})
