import * as AtomRegistry from 'effect/unstable/reactivity/AtomRegistry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ElectronRpcBridge, ElectronRpcFrame } from '../../../shared/rpc/electron-rpc'
import { ConfigRpcClient } from './config-rpc'

afterEach(() => vi.unstubAllGlobals())

describe('ConfigRpcClient.watch', () => {
  it('follows successive snapshots without manual pulls and can restart after a failure', async () => {
    const sent: Array<ElectronRpcFrame> = []
    let listener: ((frame: ElectronRpcFrame) => void) | undefined
    const bridge: ElectronRpcBridge = {
      send: (frame) => { sent.push(frame) },
      listen: (next) => { listener = next },
      clearListener: () => { listener = undefined }
    }
    vi.stubGlobal('window', { desktopRpc: bridge })
    const registry = AtomRegistry.make()
    const release = registry.mount(ConfigRpcClient.watch)
    /** Filters acknowledgements out so only actual watch subscriptions are counted. */
    const requests = () => sent.filter((frame) => JSON.parse(frame.data)._tag === 'Request')
    /** Delivers a server message to the client that owns this subscription. */
    const respond = (frame: ElectronRpcFrame, message: object): void => {
      listener?.({
        clientId: frame.clientId,
        data: JSON.stringify({ requestId: JSON.parse(frame.data).id, ...message })
      })
    }
    try {
      await vi.waitFor(() => expect(requests()).toHaveLength(1))
      const request = requests()[0]
      expect(JSON.parse(request.data).tag).toBe('config.watch')
      for (const theme of ['system', 'dark', 'light']) {
        const snapshot = { theme, language: 'en', vaults: [], agent: { enabled: false, modelProfiles: [] } }
        respond(request, { _tag: 'Chunk', values: [snapshot] })
        await vi.waitFor(() => expect(registry.get(ConfigRpcClient.watch)).toMatchObject({
          _tag: 'Success', value: snapshot
        }))
      }
      expect(requests()).toHaveLength(1)
      respond(request, {
        _tag: 'Exit',
        exit: {
          _tag: 'Failure',
          cause: [{ _tag: 'Fail', error: { _tag: 'ConfigStoreError', operation: 'read', path: '/config.json', cause: 'unavailable' } }]
        }
      })
      await vi.waitFor(() => expect(registry.get(ConfigRpcClient.watch)._tag).toBe('Failure'))
      registry.refresh(ConfigRpcClient.watch)
      await vi.waitFor(() => expect(requests()).toHaveLength(2))
      respond(requests()[1], {
        _tag: 'Chunk',
        values: [{ theme: 'dark', language: 'en', vaults: [], agent: { enabled: false, modelProfiles: [] } }]
      })
      await vi.waitFor(() => expect(registry.get(ConfigRpcClient.watch)).toMatchObject({
        _tag: 'Success', value: { theme: 'dark' }
      }))
    } finally {
      release()
      registry.dispose()
    }
    expect(listener).toBeUndefined()
  })
})
