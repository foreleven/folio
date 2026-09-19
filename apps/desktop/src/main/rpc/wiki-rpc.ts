import { Effect, Layer } from 'effect'
import { WikiMiddleware, WikiRpcs } from '../../shared/rpc/wiki-rpc'
import { WikiService } from '../../shared/wiki-service'
import { HarnessStoreError } from '../../shared/harness'
import { VaultWindowContexts } from '../services/vault/vault-window-contexts'

export const WikiRpcHandlersLive = WikiRpcs.toLayer(Effect.succeed(WikiRpcs.of({
  'wiki.snapshot': () => Effect.flatMap(WikiService, service => service.snapshot),
  'wiki.read': ({ id }) => Effect.flatMap(WikiService, service => service.read(id)),
  'wiki.save': ({ input }) => Effect.flatMap(WikiService, service => service.save(input)),
  'wiki.saveTypes': ({ input }) => Effect.flatMap(WikiService, service => service.saveTypes(input))
})))

export const WikiMiddlewareLive = Layer.effect(WikiMiddleware, Effect.gen(function* () {
  const windows = yield* VaultWindowContexts
  return (effect, { client }) => {
    const context = windows.get(client.id)
    return context ? Effect.provide(effect, context) : Effect.fail(new HarnessStoreError({
      reason: 'not-found', message: 'This window is not bound to an open Vault.'
    }))
  }
}))
