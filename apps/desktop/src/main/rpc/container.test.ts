import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { createRpcContainer, getJsonRpcServer } from './container'

describe('RPC dependency container', () => {
  it('resolves the complete graph and owns the server singleton lifecycle', () => {
    const container = createRpcContainer()

    const firstServer = getJsonRpcServer(container)
    const secondServer = getJsonRpcServer(container)

    expect(firstServer).toBe(secondServer)
  })
})
