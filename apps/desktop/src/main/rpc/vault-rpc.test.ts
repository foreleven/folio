import { Effect, Layer } from 'effect'
import { RpcTest } from 'effect/unstable/rpc'
import { describe, expect, it } from 'vitest'
import { VaultRpcs } from '../../shared/rpc/vault-rpc'
import { VaultError } from '../../shared/vault'
import { MainWindow } from '../electron/MainWindow'
import { VaultLauncher } from '../electron/VaultLauncher'
import { VaultRpcHandlersLive } from './vault-rpc'

const vault = { id: '407bc090-c297-4b3b-96bb-6ced8f64b89c', name: 'wiki', path: '/wiki' }

/** Provides window context and a controllable selection result through the actual RPC handlers. */
function handlers(open: VaultLauncher['Service']['open']) {
  return VaultRpcHandlersLive.pipe(Layer.provide(Layer.merge(
    Layer.succeed(VaultLauncher)({ open }),
    Layer.succeed(MainWindow)({ open: Effect.void, openVault: () => Effect.void, isOpen: Effect.succeed(true), getVault: (id) => Effect.succeed(id === vault.id ? vault : null) })
  )))
}

describe('Vault RPC', () => {
  it('opens a vault and resolves stable window contexts across independent clients', async () => {
    const results = await Effect.runPromise(Effect.gen(function*() {
      const a = yield* RpcTest.makeClient(VaultRpcs)
      const b = yield* RpcTest.makeClient(VaultRpcs)
      return [yield* a['vault.open'](), yield* b['vault.get']({ id: vault.id }), yield* b['vault.get']({ id: 'unknown' })]
    }).pipe(Effect.provide(handlers(Effect.succeed(vault))), Effect.scoped))
    expect(results).toEqual([vault, vault, null])
  })

  it('preserves cancellation and serializable failures', async () => {
    const cancelled = await Effect.runPromise(Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(VaultRpcs)
      return yield* client['vault.open']()
    }).pipe(Effect.provide(handlers(Effect.succeed(null))), Effect.scoped))
    expect(cancelled).toBeNull()
    const error = await Effect.runPromise(Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(VaultRpcs)
      return yield* Effect.flip(client['vault.open']())
    }).pipe(Effect.provide(handlers(Effect.fail(new VaultError({ message: 'Permission denied', cause: 'EACCES' })))), Effect.scoped))
    expect(error).toMatchObject({ _tag: 'VaultError', message: 'Permission denied' })
  })
})
