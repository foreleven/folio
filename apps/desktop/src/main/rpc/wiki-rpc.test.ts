import { Effect, Layer } from 'effect'
import { RpcTest } from 'effect/unstable/rpc'
import { expect, it } from 'vitest'
import { WikiMiddleware, WikiRpcs } from '../../shared/rpc/wiki-rpc'
import { WikiService } from '../../shared/wiki-service'
import { defaultObjectTypes, newPageMetadata, type SavePage } from '../../shared/wiki'
import { WikiRpcHandlersLive } from './wiki-rpc'

it('roundtrips Page metadata and Markdown through the actual RPC schema without accepting extra file paths', async () => {
  let saved: SavePage | undefined
  const handlers = WikiRpcHandlersLive.pipe(Layer.provideMerge(Layer.succeed(WikiMiddleware)(effect => effect.pipe(
    Effect.provideService(WikiService, {
      snapshot: Effect.succeed({ pages: [], objectTypes: defaultObjectTypes, typesVersion: '', issues: [] }),
      read: () => Effect.die('unused'), saveTypes: () => Effect.die('unused'),
      save: input => Effect.sync(() => { saved = input; return { ...input.metadata, body: input.body, path: 'one.md', version: 'v1' } })
    })
  ))))
  await Effect.runPromise(Effect.gen(function* () {
    const client = yield* RpcTest.makeClient(WikiRpcs)
    expect((yield* client['wiki.snapshot']({})).objectTypes).toEqual(defaultObjectTypes)
    const page = yield* client['wiki.save']({ input: {
      metadata: { ...newPageMetadata('one'), title: 'Knowledge' }, body: '# Body', expectedVersion: null
    } })
    expect(page).toMatchObject({ id: 'one', path: 'one.md', body: '# Body', version: 'v1' })
    expect(saved?.metadata).not.toHaveProperty('body')
    expect(saved?.metadata).not.toHaveProperty('path')
  }).pipe(Effect.provide(handlers), Effect.scoped))
})
