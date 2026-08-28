import * as Atom from 'effect/unstable/reactivity/Atom'
import * as AtomRegistry from 'effect/unstable/reactivity/AtomRegistry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ElectronRpcBridge,
  ElectronRpcFrame
} from '../../shared/rpc/electron-rpc'
import {
  checkRuntimeAtom,
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
    const release = registry.mount(checkRuntimeAtom)
    registry.mount(runtimeStateAtom)
    registry.set(checkRuntimeAtom, undefined)

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

    registry.set(checkRuntimeAtom, undefined)
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    const failedRequest = sent[1]
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
    await vi.waitFor(() => expect(sent).toHaveLength(3))
    registry.set(checkRuntimeAtom, Atom.Interrupt)

    await vi.waitFor(() =>
      expect(registry.get(runtimeStateAtom)).toEqual({ _tag: 'Unavailable' })
    )

    release()
    registry.dispose()
    expect(listener).toBeUndefined()
  })
})
