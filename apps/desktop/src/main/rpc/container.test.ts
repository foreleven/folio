import 'reflect-metadata'
import { describe, expect, it, vi } from 'vitest'
import { createRpcContainer, getRpcServer } from './container'
import { SystemRpcHandler } from './handlers/system-rpc-handler'
import { RpcServer } from './server'
import { SystemService } from '../services/system-service'

vi.mock('electron', () => ({ app: { getVersion: () => '1.2.3' } }))

describe('RPC dependency container', () => {
  it('resolves same-name interface tokens and registers the system namespace once', async () => {
    const container = createRpcContainer()

    const firstServer: RpcServer = getRpcServer(container)
    const secondServer: RpcServer = getRpcServer(container)

    expect(firstServer).toBe(secondServer)
    expect(RpcServer).toBe(Symbol.for('folio.rpc.RpcServer'))
    expect(SystemRpcHandler).toBe(Symbol.for('folio.rpc.SystemRpcHandler'))
    expect(SystemService).toBe(Symbol.for('folio.services.SystemService'))
    await expect(
      firstServer.handleMessage(
        JSON.stringify({ jsonrpc: '2.0', method: 'system.getInfo', id: 1 })
      )
    ).resolves.toBe(
      JSON.stringify({
        jsonrpc: '2.0',
        result: { platform: process.platform, version: '1.2.3' },
        id: 1
      })
    )
  })
})
