import * as Atom from 'effect/unstable/reactivity/Atom'
import * as AtomRegistry from 'effect/unstable/reactivity/AtomRegistry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ElectronRpcBridge,
  ElectronRpcFrame
} from '../../shared/rpc/electron-rpc'
import {
  checkRuntimeAtom,
  checkRuntimeThrottleAtom,
  requestRuntimeCheckAtom,
  runtimeStateAtom
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
    const releaseThrottle = registry.mount(checkRuntimeThrottleAtom)
    const release = registry.mount(checkRuntimeAtom)
    registry.mount(runtimeStateAtom)
    const releaseRequests = registry.mount(requestRuntimeCheckAtom)
    registry.set(requestRuntimeCheckAtom, undefined)
    registry.set(requestRuntimeCheckAtom, undefined)
    registry.set(requestRuntimeCheckAtom, undefined)

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
      expect(registry.get(runtimeStateAtom)).toEqual({
        _tag: 'Available',
        platform: 'darwin',
        version: '1.2.3'
      })
    )

    // The first burst is throttled to one RPC request.
    expect(sent).toHaveLength(1)

    // Once the one-second window expires, the next click is allowed through.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    registry.set(requestRuntimeCheckAtom, undefined)
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
      expect(registry.get(runtimeStateAtom)).toEqual({
        _tag: 'Available',
        platform: 'darwin',
        version: '1.2.3'
      })
    )

    registry.set(checkRuntimeAtom, undefined)
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
      expect(registry.get(runtimeStateAtom)).toEqual({ _tag: 'Unavailable' })
    )

    registry.set(checkRuntimeAtom, undefined)
    await vi.waitFor(() => expect(sent).toHaveLength(4))
    registry.set(checkRuntimeAtom, Atom.Interrupt)

    await vi.waitFor(() =>
      expect(registry.get(runtimeStateAtom)).toEqual({ _tag: 'Unavailable' })
    )

    release()
    releaseThrottle()
    releaseRequests()
    registry.dispose()
    expect(listener).toBeUndefined()
  })
})
