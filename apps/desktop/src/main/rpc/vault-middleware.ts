import { Effect, Layer } from 'effect'
import { HarnessStoreError } from '../../shared/harness'
import { VaultMiddleware } from '../../shared/rpc/vault-middleware'
import { VaultWindowContexts } from '../services/vault-window-contexts'

/** Resolves identity from the transport's native sender binding, ignoring payload and headers. */
export const VaultMiddlewareLive = Layer.effect(
  VaultMiddleware,
  Effect.gen(function* () {
    const windows = yield* VaultWindowContexts
    return (effect, { client }) => {
      const context = windows.get(client.id)
      return context ? Effect.provide(effect, context) : Effect.fail(new HarnessStoreError({ reason: 'not-found', message: 'This window is not bound to an open Vault.' }))
    }
  })
)
