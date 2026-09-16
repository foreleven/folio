import { TaskService } from '../../shared/task-service'
import { VaultMiddleware } from '../../shared/rpc/vault-middleware'
import { VaultContext, makeVaultContext } from '../services/vault-context'
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
  return VaultRpcHandlersLive.pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(VaultLauncher)({
          open,
          openExisting: (id) => (id === vault.id ? Effect.succeed(vault) : Effect.fail(new VaultError({ message: 'Unknown vault', cause: id }))),
          remove: (id) => (id === vault.id ? Effect.succeed(vault) : Effect.fail(new VaultError({ message: 'Unknown vault', cause: id })))
        }),
        Layer.succeed(MainWindow)({
          open: Effect.void,
          openVault: () => Effect.void,
          closeVault: () => Effect.void,
          isOpen: Effect.succeed(true),
          getVault: (id) => Effect.succeed(id === vault.id ? vault : null)
        })
      )
    ),
    Layer.provideMerge(
      Layer.succeed(VaultMiddleware)((effect) =>
        effect.pipe(Effect.provideService(VaultContext, makeVaultContext(vault, '/config')), Effect.provideService(TaskService, {} as TaskService['Service']))
      )
    )
  )
}

describe('Vault RPC', () => {
  it('opens a vault and resolves stable window contexts across independent clients', async () => {
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const a = yield* RpcTest.makeClient(VaultRpcs)
        const b = yield* RpcTest.makeClient(VaultRpcs)
        return [yield* a['vault.open'](), yield* b['vault.get']({}), yield* b['vault.get']({})]
      }).pipe(Effect.provide(handlers(Effect.succeed(vault))), Effect.scoped)
    )
    expect(results).toEqual([vault, vault, vault])
  })

  it('preserves cancellation and serializable failures', async () => {
    const cancelled = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(VaultRpcs)
        return yield* client['vault.open']()
      }).pipe(Effect.provide(handlers(Effect.succeed(null))), Effect.scoped)
    )
    expect(cancelled).toBeNull()
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(VaultRpcs)
        return yield* Effect.flip(client['vault.open']())
      }).pipe(Effect.provide(handlers(Effect.fail(new VaultError({ message: 'Permission denied', cause: 'EACCES' })))), Effect.scoped)
    )
    expect(error).toMatchObject({ _tag: 'VaultError', message: 'Permission denied' })
  })

  it('routes saved vault IDs and preserves unknown-vault errors', async () => {
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(VaultRpcs)
        return [
          yield* client['vault.openExisting']({ id: vault.id }),
          yield* Effect.flip(client['vault.openExisting']({ id: '407bc090-c297-4b3b-96bb-6ced8f64b89d' })),
          yield* client['vault.remove']({ id: vault.id })
        ]
      }).pipe(Effect.provide(handlers(Effect.succeed(null))), Effect.scoped)
    )
    expect(results[0]).toEqual(vault)
    expect(results[1]).toMatchObject({ _tag: 'VaultError', message: 'Unknown vault' })
    expect(results[2]).toEqual(vault)
  })
})
