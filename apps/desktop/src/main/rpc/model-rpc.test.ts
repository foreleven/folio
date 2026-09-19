import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import type { ModelProfile } from '@folio/agent/config/schema'
import {
  type ModelCatalogSnapshot,
  type PiModelRuntimeAdapter
} from '@folio/agent/model'
import { ConfigProvider, Deferred, Effect, Fiber, Layer, Redacted, Stream } from 'effect'
import { RpcTest } from 'effect/unstable/rpc'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ModelRpcs } from '../../shared/rpc/model-rpc'
import { ConfigService } from '../services/config/config-service'
import { ModelService } from '../services/models/model-service'
import { ModelRpcHandlersLive } from './model-rpc'

const profile: ModelProfile = {
  id: 'rpc-profile',
  name: 'RPC profile',
  provider: {
    type: 'custom',
    providerId: 'rpc-provider',
    baseUrl: 'https://api.example.test/v1',
    api: 'openai-completions'
  },
  modelId: 'rpc-model',
  thinkingLevel: 'medium',
  credentialSource: 'managed',
  customModel: {
    displayName: 'RPC model',
    reasoning: false,
    contextWindow: 16_000,
    maxTokens: 4_000
  }
}

const catalog: ModelCatalogSnapshot = {
  stale: false,
  models: [{
    providerId: 'rpc-provider',
    providerName: 'RPC provider',
    modelId: 'rpc-model',
    modelName: 'RPC model',
    api: 'openai-completions',
    source: 'custom',
    reasoning: false,
    input: ['text'],
    contextWindow: 16_000,
    maxTokens: 4_000
  }]
}

const runtimeAdapter: PiModelRuntimeAdapter = {
  listCatalog: () => Effect.succeed(catalog),
  refreshCatalog: () => Effect.succeed({ ...catalog, stale: true }),
  testConnection: () => Effect.void
}

const makeHandlers = (directory: string) => {
  const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)
  const config = ConfigService.layer.pipe(
    Layer.provide(platform),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ FOLIO_CONFIG_DIR: directory })))
  )
  const models = ModelService.layer({ environment: {}, runtimeAdapter }).pipe(
    Layer.provide(config),
    Layer.provide(platform)
  )
  return ModelRpcHandlersLive.pipe(Layer.provide(models))
}

describe('Model RPC', () => {
  it('adds a provider through RPC without requiring a model profile', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'folio-provider-rpc-'))
    try {
      const result = await Effect.runPromise(Effect.gen(function*() {
        const client = yield* RpcTest.makeClient(ModelRpcs)
        return yield* client['models.setProviderCredential']({ providerId: 'rpc-provider', credential: Redacted.make('provider-rpc-secret', { label: 'provider credential' }) })
      }).pipe(Effect.provide(makeHandlers(directory)), Effect.scoped))
      expect(result.configuredProviders).toEqual(['rpc-provider'])
      expect(result.profiles).toEqual([])
      expect(JSON.stringify(result)).not.toContain('provider-rpc-secret')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('routes model commands and streams only credential-blind committed snapshots', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'folio-model-rpc-'))
    const secret = 'rpc-one-time-secret'
    try {
      const result = await Effect.runPromise(Effect.gen(function*() {
        const watcher = yield* RpcTest.makeClient(ModelRpcs)
        const commands = yield* RpcTest.makeClient(ModelRpcs)
        const ready = yield* Deferred.make<void>()
        const snapshots = yield* watcher['models.watch']().pipe(
          Stream.tap(() => Deferred.succeed(ready, undefined)),
          Stream.take(4),
          Stream.runCollect,
          Effect.forkChild
        )
        yield* Deferred.await(ready)
        const saved = yield* commands['models.saveProfile'](profile)
        const selected = yield* commands['models.setDefault']({ profileId: profile.id })
        const credentialed = yield* commands['models.setCredential']({
          profileId: profile.id,
          credential: Redacted.make(secret, { label: 'model credential' })
        })
        yield* commands['models.rebuildDerivedConfig']()
        return { saved, selected, credentialed, snapshots: yield* Fiber.join(snapshots) }
      }).pipe(Effect.provide(makeHandlers(directory)), Effect.scoped))

      expect(result.saved.profiles[0]).toMatchObject({
        profile: { id: profile.id }, credentialConfigured: false, connectionStatus: 'untested'
      })
      expect(result.selected.defaultModelProfileId).toBe(profile.id)
      expect(result.credentialed.profiles[0]?.credentialConfigured).toBe(true)
      expect(result.snapshots).toHaveLength(4)
      expect(result.snapshots[0]).toEqual({ enabled: false, profiles: [], configuredProviders: [], piImportFailed: false })
      expect(result.snapshots[3]?.profiles[0]?.credentialConfigured).toBe(true)

      const responses = JSON.stringify(result)
      expect(responses).not.toContain(secret)
      expect(responses).not.toContain('apiKey')
      expect(responses).not.toContain('authorization')
      expect(responses).not.toContain('headers')
      expect(await readFile(join(directory, 'config.json'), 'utf8')).not.toContain(secret)
      expect(await readFile(join(directory, 'agent', 'models.generated.json'), 'utf8')).not.toContain(secret)
      expect(await readFile(join(directory, 'agent', 'auth.json'), 'utf8')).toContain(secret)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('returns catalog and connection status without credential material', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'folio-model-rpc-'))
    const secret = 'rpc-connection-secret'
    try {
      const result = await Effect.runPromise(Effect.gen(function*() {
        const client = yield* RpcTest.makeClient(ModelRpcs)
        yield* client['models.saveProfile'](profile)
        yield* client['models.setCredential']({
          profileId: profile.id,
          credential: Redacted.make(secret, { label: 'model credential' })
        })
        const listed = yield* client['models.listCatalog']()
        const refreshed = yield* client['models.refreshCatalog']()
        const connected = yield* client['models.testConnection']({ profileId: profile.id })
        return { listed, refreshed, connected }
      }).pipe(Effect.provide(makeHandlers(directory)), Effect.scoped))

      expect(result.listed).toEqual(catalog)
      expect(result.refreshed).toEqual({ ...catalog, stale: true })
      expect(result.connected.profiles[0]?.connectionStatus).toBe('ready')
      expect(JSON.stringify(result)).not.toContain(secret)
      expect(JSON.stringify(result)).not.toContain('apiKey')
      expect(JSON.stringify(result)).not.toContain('authorization')
      expect(JSON.stringify(result)).not.toContain('headers')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('persists profile, default and credential metadata across a fresh RPC layer without retaining secrets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'folio-model-rpc-restart-'))
    const secret = 'rpc-restart-secret'
    try {
      const beforeRestart = await Effect.runPromise(Effect.gen(function*() {
        const client = yield* RpcTest.makeClient(ModelRpcs)
        yield* client['models.saveProfile'](profile)
        yield* client['models.setCredential']({
          profileId: profile.id,
          credential: Redacted.make(secret, { label: 'model credential' })
        })
        const connected = yield* client['models.testConnection']({ profileId: profile.id })
        const selected = yield* client['models.setDefault']({ profileId: profile.id })
        const snapshots = yield* client['models.watch']().pipe(Stream.take(1), Stream.runCollect)
        return { connected, selected, snapshots }
      }).pipe(Effect.provide(makeHandlers(directory)), Effect.scoped))

      expect(beforeRestart.connected.profiles[0]).toMatchObject({
        profile: { id: profile.id }, credentialConfigured: true, connectionStatus: 'ready'
      })
      expect(beforeRestart.selected).toMatchObject({
        defaultModelProfileId: profile.id,
        profiles: [{ profile: { id: profile.id }, credentialConfigured: true, connectionStatus: 'ready' }]
      })

      // A new scoped Layer reconstructs ConfigService, ModelService, and the RPC handlers from disk.
      const afterRestart = await Effect.runPromise(Effect.gen(function*() {
        const client = yield* RpcTest.makeClient(ModelRpcs)
        const snapshots = yield* client['models.watch']().pipe(Stream.take(1), Stream.runCollect)
        const missingProfileError = yield* Effect.flip(
          client['models.testConnection']({ profileId: 'missing-after-restart' })
        )
        return { snapshots, missingProfileError }
      }).pipe(Effect.provide(makeHandlers(directory)), Effect.scoped))

      expect(afterRestart.snapshots).toHaveLength(1)
      expect(afterRestart.snapshots[0]).toMatchObject({
        defaultModelProfileId: profile.id,
        profiles: [{
          profile,
          credentialConfigured: true,
          // Connection status is deliberately process-local and must be re-tested after restart.
          connectionStatus: 'untested'
        }]
      })
      expect(afterRestart.missingProfileError).toMatchObject({
        _tag: 'ModelServiceError',
        reason: 'profile_not_found',
        message: 'The model profile was not found.'
      })

      const rpcState = JSON.stringify({ beforeRestart, afterRestart })
      expect(rpcState).not.toContain(secret)
      expect(rpcState).not.toContain('apiKey')
      expect(rpcState).not.toContain('authorization')
      expect(rpcState).not.toContain('headers')
      expect(rpcState).not.toContain('cause')

      const config = await readFile(join(directory, 'config.json'), 'utf8')
      const generated = await readFile(join(directory, 'agent', 'models.generated.json'), 'utf8')
      const credentials = await readFile(join(directory, 'agent', 'auth.json'), 'utf8')
      expect(config).not.toContain(secret)
      expect(generated).not.toContain(secret)
      expect(generated).not.toContain('apiKey')
      expect(generated).not.toContain('headers')
      expect(credentials).toContain(secret)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('preserves stable secret-free failures for unknown profiles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'folio-model-rpc-'))
    try {
      const error = await Effect.runPromise(Effect.gen(function*() {
        const client = yield* RpcTest.makeClient(ModelRpcs)
        return yield* Effect.flip(client['models.deleteProfile']({ profileId: 'missing-profile' }))
      }).pipe(Effect.provide(makeHandlers(directory)), Effect.scoped))
      expect(error).toMatchObject({
        _tag: 'ModelServiceError',
        reason: 'profile_not_found',
        message: 'The model profile was not found.'
      })
      expect(JSON.stringify(error)).not.toContain('cause')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
