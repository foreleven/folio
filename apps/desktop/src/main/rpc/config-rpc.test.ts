import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import { ConfigProvider, Deferred, Effect, Fiber, Layer, Stream } from 'effect'
import { RpcTest } from 'effect/unstable/rpc'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigRpcs } from '../../shared/rpc/config-rpc'
import { ConfigService } from '../services/config-service'
import { ConfigRpcHandlersLive } from './config-rpc'

describe('Configuration RPC', () => {
  it('streams a snapshot and committed changes to two independent clients', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'folio-config-rpc-'))
    const vault = { id: '01941f29-7c00-73e4-a310-744d2167fc5b', name: 'wiki', path: '/wiki' }
    const handlers = ConfigRpcHandlersLive.pipe(
      Layer.provideMerge(ConfigService.layer),
      Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ FOLIO_CONFIG_DIR: directory })))
    )
    try {
      const results = await Effect.runPromise(Effect.gen(function*() {
        const first = yield* RpcTest.makeClient(ConfigRpcs)
        const second = yield* RpcTest.makeClient(ConfigRpcs)
        const firstReady = yield* Deferred.make<void>()
        const secondReady = yield* Deferred.make<void>()
        const firstValues = yield* first['config.watch']().pipe(
          Stream.tap(() => Deferred.succeed(firstReady, undefined)),
          Stream.take(3), Stream.runCollect, Effect.forkChild
        )
        const secondValues = yield* second['config.watch']().pipe(
          Stream.tap(() => Deferred.succeed(secondReady, undefined)),
          Stream.take(3), Stream.runCollect, Effect.forkChild
        )
        yield* Deferred.await(firstReady)
        yield* Deferred.await(secondReady)
        const config = yield* ConfigService
        yield* config.addVault(vault)
        const saved = yield* first['config.update']({ theme: 'dark', language: 'zh-CN' })
        return { saved, first: yield* Fiber.join(firstValues), second: yield* Fiber.join(secondValues) }
      }).pipe(Effect.provide(handlers), Effect.scoped))
      const disabledAgent = { enabled: false, modelProfiles: [] }
      const expected = [
        { theme: 'system', language: 'system', vaults: [], agent: disabledAgent },
        { theme: 'system', language: 'system', vaults: [vault], agent: disabledAgent },
        { theme: 'dark', language: 'zh-CN', vaults: [vault], agent: disabledAgent }
      ]
      expect(results.first).toEqual(expected)
      expect(results.second).toEqual(expected)
      expect(JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'))).toEqual(results.saved)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('returns typed read and update failures for a corrupted file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'folio-config-rpc-'))
    const handlers = ConfigRpcHandlersLive.pipe(
      Layer.provide(ConfigService.layer),
      Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ FOLIO_CONFIG_DIR: directory })))
    )
    try {
      await writeFile(join(directory, 'config.json'), '{broken')
      const errors = await Effect.runPromise(Effect.gen(function*() {
        const client = yield* RpcTest.makeClient(ConfigRpcs)
        const read = yield* Effect.flip(Stream.runHead(client['config.watch']()))
        const update = yield* Effect.flip(client['config.update']({ theme: 'light' }))
        return { read, update }
      }).pipe(Effect.provide(handlers), Effect.scoped))
      expect(errors.read).toMatchObject({ _tag: 'ConfigStoreError', operation: 'read' })
      expect(errors.update).toMatchObject({ _tag: 'ConfigStoreError', operation: 'update' })
      expect(await readFile(join(directory, 'config.json'), 'utf8')).toBe('{broken')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
