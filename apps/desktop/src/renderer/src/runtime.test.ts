import { Effect } from 'effect'
import * as AtomRegistry from 'effect/unstable/reactivity/AtomRegistry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ElectronRpcBridge,
  ElectronRpcFrame
} from '../../shared/rpc/electron-rpc'
import { checkSystemInfoAtom } from './runtime'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('renderer Effect atoms', () => {
  it('runs the generated system client through the Atom registry', async () => {
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
    const release = registry.mount(checkSystemInfoAtom)
    registry.set(checkSystemInfoAtom, undefined)

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

    const result = await Effect.runPromise(
      AtomRegistry.getResult(registry, checkSystemInfoAtom)
    )
    expect(result).toEqual({
      platform: 'darwin',
      version: '1.2.3'
    })

    release()
    registry.dispose()
    expect(listener).toBeUndefined()
  })
})
