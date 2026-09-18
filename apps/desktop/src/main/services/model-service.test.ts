import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import type { ModelProfile } from '@folio/agent/config/schema'
import { loadFolioAgentConfig } from '@folio/agent/config/loader'
import {
  ModelRuntimeAdapterError,
  type ModelCatalogSnapshot,
  type PiModelRuntimeAdapter
} from '@folio/agent/model'
import { ConfigProvider, Effect, FileSystem, Layer, ManagedRuntime, Redacted, Stream } from 'effect'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigService } from './config-service'
import { ModelService } from './model-service'

let root: string

const customProfile = (id: string, overrides: Partial<ModelProfile> = {}): ModelProfile => ({
  id,
  name: `Profile ${id}`,
  provider: {
    type: 'custom',
    providerId: `provider-${id}`,
    baseUrl: 'https://api.example.test/v1',
    api: 'openai-completions'
  },
  modelId: `model-${id}`,
  thinkingLevel: 'medium',
  credentialSource: 'managed',
  customModel: {
    displayName: `Model ${id}`,
    reasoning: false,
    contextWindow: 16_000,
    maxTokens: 4_000
  },
  ...overrides
})

const catalog: ModelCatalogSnapshot = {
  stale: false,
  models: [{
    providerId: 'provider-connected',
    providerName: 'Connected provider',
    modelId: 'model-connected',
    modelName: 'Connected model',
    api: 'openai-completions',
    source: 'custom',
    reasoning: false,
    input: ['text'],
    contextWindow: 16_000,
    maxTokens: 4_000
  }]
}

const runtimeAdapter = (overrides: Partial<PiModelRuntimeAdapter> = {}): PiModelRuntimeAdapter => ({
  listCatalog: () => Effect.succeed(catalog),
  refreshCatalog: () => Effect.succeed({ ...catalog, stale: true }),
  testConnection: () => Effect.void,
  ...overrides
})

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'folio-model-service-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function makeRuntime(
  filesystem = NodeFileSystem.layer,
  environment: Readonly<Record<string, string | undefined>> = {},
  runtimeAdapter?: PiModelRuntimeAdapter
) {
  const platform = Layer.merge(filesystem, NodePath.layer)
  const config = ConfigService.layer.pipe(
    Layer.provide(platform),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ FOLIO_CONFIG_DIR: root })))
  )
  return ManagedRuntime.make(ModelService.layer({ environment, ...(runtimeAdapter === undefined ? {} : { runtimeAdapter }) }).pipe(
    Layer.provide(config),
    Layer.provide(platform)
  ))
}

async function withService<A>(
  consume: (service: ModelService['Service']) => Promise<A>,
  runtime = makeRuntime()
): Promise<A> {
  try {
    return await consume(await runtime.runPromise(ModelService))
  } finally {
    await runtime.dispose()
  }
}

describe('ModelService', () => {
  it('saves a provider key without creating a model profile or default selection', async () => {
    await withService(async (service) => {
      const view = await Effect.runPromise(service.setProviderCredential('provider-connected', Redacted.make('provider-only-secret')))
      expect(view).toMatchObject({ configuredProviders: ['provider-connected'], profiles: [] })
      expect(view.defaultModelProfileId).toBeUndefined()
      expect(JSON.stringify(view)).not.toContain('provider-only-secret')
      expect(await readFile(join(service.directory, 'auth.json'), 'utf8')).toContain('provider-only-secret')
      await expect(Effect.runPromise(service.setProviderCredential('unknown', Redacted.make('secret')))).rejects.toMatchObject({ reason: 'provider_unavailable' })
      await expect(Effect.runPromise(service.setProviderCredential('provider-connected', Redacted.make('   ')))).rejects.toMatchObject({ reason: 'credential_unavailable' })
    }, makeRuntime(NodeFileSystem.layer, {}, runtimeAdapter()))
  })

  it('imports providers from the standard Pi agent directory', async () => {
    await mkdir(join(root, '.pi', 'agent'), { recursive: true })
    await writeFile(join(root, '.pi', 'agent', 'auth.json'), JSON.stringify({
      openrouter: { type: 'api_key', key: 'fixture-key' },
      'minimax-cn': { type: 'api_key', key: 'fixture-key-2' }
    }))
    await withService(async (service) => {
      const view = await Effect.runPromise(service.list)
      expect(view.configuredProviders).toEqual(['openrouter', 'minimax-cn'])
      expect(view.piImportFailed).toBe(false)
    }, makeRuntime(NodeFileSystem.layer, { HOME: root }, runtimeAdapter()))
  })

  it('discovers local Pi providers without leaking credentials or inventing a model selection', async () => {
    await mkdir(join(root, '.pi'))
    await writeFile(join(root, '.pi', 'auth.json'), JSON.stringify({ anthropic: { type: 'api_key', key: 'private-pi-key' } }))
    await withService(async (service) => {
      const view = await Effect.runPromise(service.list)
      expect(view).toMatchObject({ configuredProviders: ['anthropic'], profiles: [], piImportFailed: false })
      expect(JSON.stringify(view)).not.toContain('private-pi-key')
      const saved = await Effect.runPromise(service.saveProfile({ id: 'pi', name: 'Pi model', provider: { type: 'builtin', providerId: 'anthropic' }, modelId: 'claude-sonnet-4-5', thinkingLevel: 'medium', credentialSource: 'managed' }))
      expect(saved.profiles[0]?.credentialConfigured).toBe(true)
    }, makeRuntime(NodeFileSystem.layer, { HOME: root }, runtimeAdapter()))
  })

  it('keeps manual configuration usable when the local Pi file is invalid', async () => {
    await mkdir(join(root, '.pi'))
    await writeFile(join(root, '.pi', 'auth.json'), 'invalid-private-content')
    await withService(async (service) => {
      expect(await Effect.runPromise(service.list)).toMatchObject({ piImportFailed: true, configuredProviders: [] })
      expect((await Effect.runPromise(service.saveProfile(customProfile('manual')))).profiles).toHaveLength(1)
    }, makeRuntime(NodeFileSystem.layer, { HOME: root }, runtimeAdapter()))
  })

  it('persists profiles/defaults and atomically rebuilds credential-blind Pi config', async () => {
    await withService(async (service) => {
      const profile = customProfile('primary')
      expect(await service.saveProfile(profile).pipe(Effect.runPromise)).toMatchObject({
        enabled: false,
        profiles: [{ profile, credentialConfigured: false, connectionStatus: 'untested' }]
      })
      expect(await service.setDefault(profile.id).pipe(Effect.runPromise)).toMatchObject({
        defaultModelProfileId: profile.id
      })

      const persisted = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))
      expect(persisted.agent).toEqual({
        enabled: false,
        modelProfiles: [profile],
        defaultModelProfileId: profile.id
      })
      const generated = await readFile(service.modelsPath, 'utf8')
      expect(generated).toContain('// sourceChecksum: sha256:')
      expect(generated).toContain('provider-primary')
      expect(generated).not.toContain('credentialSource')
      expect(generated).not.toContain('apiKey')
      expect(generated).not.toContain('headers')
      expect((await stat(service.directory)).mode & 0o777).toBe(0o700)
      expect((await stat(service.modelsPath)).mode & 0o777).toBe(0o600)
      expect((await readdir(service.directory)).sort()).toEqual(['auth.json', 'models.generated.json'])
    })
  })

  it('resolves the same default profile as the standalone loader for one FOLIO_CONFIG_DIR', async () => {
    await withService(async (service) => {
      const profile = customProfile('shared-default', {
        credentialSource: 'none'
      })
      await Effect.runPromise(service.saveProfile(profile))
      const desktop = await Effect.runPromise(service.setDefault(profile.id))
      const standalone = await Effect.runPromise(loadFolioAgentConfig({
        env: { FOLIO_CONFIG_DIR: root }
      }))

      expect(desktop.defaultModelProfileId).toBe(profile.id)
      expect(desktop.profiles.find(({ profile: candidate }) => candidate.id === desktop.defaultModelProfileId)?.profile)
        .toEqual(standalone.defaultProfile)
      expect(standalone.configDirectory).toBe(root)
      expect(standalone.agentDirectory).toBe(service.directory)
    })
  })

  it('accepts a built-in catalog profile without adding a custom provider entry', async () => {
    await withService(async (service) => {
      const profile: ModelProfile = {
        id: 'builtin',
        name: 'Built-in',
        provider: { type: 'builtin', providerId: 'anthropic' },
        modelId: 'claude-sonnet-4-5',
        thinkingLevel: 'medium',
        credentialSource: 'none'
      }
      const view = await Effect.runPromise(service.saveProfile(profile))
      expect(view.profiles[0]).toMatchObject({
        profile,
        credentialConfigured: true,
        connectionStatus: 'untested'
      })
      const generated = await readFile(service.modelsPath, 'utf8')
      expect(generated).toContain('"providers": {}')
    })
  })

  it('rebuilds a damaged derived file exclusively from config.json', async () => {
    await withService(async (service) => {
      const profile = customProfile('rebuilt')
      await Effect.runPromise(service.saveProfile(profile))
      await import('node:fs/promises').then(({ writeFile }) => writeFile(
        service.modelsPath,
        '{"apiKey":"must-not-survive"}',
        'utf8'
      ))
      await Effect.runPromise(service.rebuildDerivedConfig)
      const generated = await readFile(service.modelsPath, 'utf8')
      expect(generated).toContain('provider-rebuilt')
      expect(generated).not.toContain('must-not-survive')
      expect(generated).toContain('// sourceChecksum: sha256:')
    })
  })

  it('publishes an initial and committed credential-blind view', async () => {
    const runtime = makeRuntime()
    try {
      const service = await runtime.runPromise(ModelService)
      const snapshots = runtime.runPromise(service.watch.pipe(Stream.take(2), Stream.runCollect))
      await new Promise((resolve) => setTimeout(resolve, 0))
      await runtime.runPromise(service.saveProfile(customProfile('watched')))
      const values = await snapshots
      expect(values).toHaveLength(2)
      expect(values[0]).toEqual({ enabled: false, profiles: [], configuredProviders: [], piImportFailed: false })
      expect(values[1]?.profiles[0]).toMatchObject({
        profile: { id: 'watched' }, credentialConfigured: false, connectionStatus: 'untested'
      })
      expect(JSON.stringify(values)).not.toContain('apiKey')
    } finally {
      await runtime.dispose()
    }
  })

  it('honors the shared FOLIO_AGENT_DIR resolver override', async () => {
    const agentDirectory = join(root, 'explicit-agent')
    await withService(async (service) => {
      expect(service.directory).toBe(agentDirectory)
      await Effect.runPromise(service.saveProfile(customProfile('override')))
      expect(await readdir(agentDirectory)).toContain('models.generated.json')
      expect(await readdir(join(root))).not.toContain('agent')
    }, makeRuntime(NodeFileSystem.layer, { FOLIO_AGENT_DIR: agentDirectory }))
  })

  it('serializes concurrent profile saves without losing either profile', async () => {
    await withService(async (service) => {
      await Effect.all([
        service.saveProfile(customProfile('one')),
        service.saveProfile(customProfile('two'))
      ], { concurrency: 'unbounded' }).pipe(Effect.runPromise)

      const view = await Effect.runPromise(service.list)
      expect(view.profiles.map(({ profile }) => profile.id).sort()).toEqual(['one', 'two'])
      const persisted = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))
      expect(persisted.agent.modelProfiles.map(({ id }: { id: string }) => id).sort()).toEqual(['one', 'two'])
    })
  })

  it('stores and deletes managed credentials by profile id without exposing the API key', async () => {
    await withService(async (service) => {
      const profile = customProfile('secure')
      await Effect.runPromise(service.saveProfile(profile))
      const secret = 'model-service-secret'
      const configured = await Effect.runPromise(service.setCredential(profile.id, Redacted.make(secret)))
      expect(configured.profiles[0]?.credentialConfigured).toBe(true)
      expect(JSON.stringify(configured)).not.toContain(secret)
      expect(await readFile(join(root, 'config.json'), 'utf8')).not.toContain(secret)
      expect(await readFile(service.modelsPath, 'utf8')).not.toContain(secret)
      expect(await readFile(join(service.directory, 'auth.json'), 'utf8')).toContain(secret)

      const removed = await Effect.runPromise(service.deleteCredential(profile.id))
      expect(removed.profiles[0]?.credentialConfigured).toBe(false)
      expect(await readFile(join(service.directory, 'auth.json'), 'utf8')).not.toContain(secret)
    })
  })

  it('does not delete a provider credential still referenced by another managed profile', async () => {
    await withService(async (service) => {
      const first = customProfile('shared-one', {
        provider: {
          type: 'custom', providerId: 'shared-provider',
          baseUrl: 'https://api.example.test/v1', api: 'openai-completions'
        }
      })
      const second = customProfile('shared-two', {
        provider: {
          type: 'custom', providerId: 'shared-provider',
          baseUrl: 'https://api.example.test/v1', api: 'openai-completions'
        }
      })
      await Effect.runPromise(service.saveProfile(first))
      await Effect.runPromise(service.saveProfile(second))
      await Effect.runPromise(service.setCredential(first.id, Redacted.make('shared-secret')))
      await expect(Effect.runPromise(service.deleteCredential(first.id))).rejects.toMatchObject({
        _tag: 'ModelServiceError', reason: 'credential_shared'
      })
      expect(await readFile(join(service.directory, 'auth.json'), 'utf8')).toContain('shared-secret')
    })
  })

  it('invalidates every managed profile sharing a rotated credential', async () => {
    await withService(async (service) => {
      const first = customProfile('shared-first')
      const second = customProfile('shared-second', { provider: first.provider, modelId: 'second-model' })
      const independent = customProfile('environment-profile', {
        provider: first.provider, modelId: 'environment-model', credentialSource: 'environment', environmentVariable: 'MODEL_TEST_KEY'
      })
      for (const profile of [first, second, independent]) {
        await Effect.runPromise(service.saveProfile(profile))
        await Effect.runPromise(service.testConnection(profile.id))
      }
      const view = await Effect.runPromise(service.setCredential(first.id, Redacted.make('rotated-key')))
      expect(view.profiles.map(({ connectionStatus }) => connectionStatus)).toEqual(['untested', 'untested', 'ready'])
    }, makeRuntime(NodeFileSystem.layer, { MODEL_TEST_KEY: 'independent-key' }, runtimeAdapter()))
  })

  it('reports environment credentials only as configured metadata', async () => {
    const profile = customProfile('environment', {
      credentialSource: 'environment',
      environmentVariable: 'MODEL_TEST_KEY'
    })
    await withService(async (service) => {
      const view = await Effect.runPromise(service.saveProfile(profile))
      expect(view.profiles[0]?.credentialConfigured).toBe(true)
      expect(JSON.stringify(view)).not.toContain('environment-secret')
      expect(await readFile(join(root, 'config.json'), 'utf8')).not.toContain('environment-secret')
    }, makeRuntime(NodeFileSystem.layer, { MODEL_TEST_KEY: 'environment-secret' }))
  })

  it('lists and refreshes credential-blind catalog snapshots through the Agent adapter', async () => {
    await withService(async (service) => {
      expect(await Effect.runPromise(service.listCatalog)).toEqual(catalog)
      expect(await Effect.runPromise(service.refreshCatalog)).toEqual({ ...catalog, stale: true })
      expect(JSON.stringify(await Effect.runPromise(service.listCatalog))).not.toContain('credential')
    }, makeRuntime(NodeFileSystem.layer, {}, runtimeAdapter()))
  })

  it('publishes ready/unavailable connection status and resets it after credential changes', async () => {
    const profile = customProfile('connected')
    let succeeds = true
    const adapter = runtimeAdapter({
      testConnection: () => succeeds
        ? Effect.void
        : Effect.fail(new ModelRuntimeAdapterError({
          reason: 'provider_unavailable',
          message: 'Model provider is unavailable.'
        }))
    })
    await withService(async (service) => {
      await Effect.runPromise(service.saveProfile(profile))
      await Effect.runPromise(service.setCredential(profile.id, Redacted.make('connection-secret')))
      expect(await Effect.runPromise(service.testConnection(profile.id))).toMatchObject({
        profiles: [{ profile: { id: profile.id }, connectionStatus: 'ready' }]
      })

      succeeds = false
      const error = await Effect.runPromise(Effect.flip(service.testConnection(profile.id)))
      expect(error).toMatchObject({
        _tag: 'ModelServiceError',
        reason: 'provider_unavailable',
        message: 'The model provider is unavailable.'
      })
      expect(JSON.stringify(error)).not.toContain('cause')
      expect(await Effect.runPromise(service.list)).toMatchObject({
        profiles: [{ profile: { id: profile.id }, connectionStatus: 'unavailable' }]
      })

      expect(await Effect.runPromise(service.setCredential(profile.id, Redacted.make('rotated-secret')))).toMatchObject({
        profiles: [{ profile: { id: profile.id }, connectionStatus: 'untested' }]
      })
      expect(JSON.stringify(await Effect.runPromise(service.list))).not.toContain('connection-secret')
      expect(JSON.stringify(await Effect.runPromise(service.list))).not.toContain('rotated-secret')
    }, makeRuntime(NodeFileSystem.layer, {}, adapter))
  })

  it('maps credential, catalog and cancellation adapter failures to stable service errors', async () => {
    const cases = [
      ['credential_missing', 'credential_unavailable'],
      ['catalog_unavailable', 'catalog_unavailable'],
      ['operation_aborted', 'operation_aborted']
    ] as const
    for (const [adapterReason, serviceReason] of cases) {
      const adapter = runtimeAdapter({
        listCatalog: () => Effect.fail(new ModelRuntimeAdapterError({
          reason: adapterReason,
          message: 'sensitive provider detail'
        }))
      })
      await withService(async (service) => {
        const error = await Effect.runPromise(Effect.flip(service.listCatalog))
        expect(error).toMatchObject({ _tag: 'ModelServiceError', reason: serviceReason })
        expect(JSON.stringify(error)).not.toContain('sensitive provider detail')
        expect(JSON.stringify(error)).not.toContain('cause')
      }, makeRuntime(NodeFileSystem.layer, {}, adapter))
    }
  })

  it('rejects invalid profiles, unknown ids and deleting the active default with stable errors', async () => {
    await withService(async (service) => {
      const profile = customProfile('default')
      await Effect.runPromise(service.saveProfile(profile))
      await Effect.runPromise(service.setDefault(profile.id))

      await expect(Effect.runPromise(service.deleteProfile(profile.id))).rejects.toMatchObject({
        _tag: 'ModelServiceError', reason: 'default_profile_delete'
      })
      await expect(Effect.runPromise(service.setDefault('missing'))).rejects.toMatchObject({
        _tag: 'ModelServiceError', reason: 'profile_not_found'
      })
      await expect(Effect.runPromise(service.deleteCredential('missing'))).rejects.toMatchObject({
        _tag: 'ModelServiceError', reason: 'profile_not_found'
      })
      await expect(Effect.runPromise(
        // @ts-expect-error Deliberately invalid input exercises the service Schema boundary.
        service.saveProfile({ ...profile, apiKey: 'must-not-persist' })
      )).rejects.toMatchObject({ _tag: 'ModelServiceError', reason: 'invalid_profile' })
      expect(await readFile(join(root, 'config.json'), 'utf8')).not.toContain('must-not-persist')
    })
  })

  it('keeps committed config as source of truth when derived replacement fails', async () => {
    const failingFilesystem = Layer.effect(FileSystem.FileSystem, Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      return FileSystem.FileSystem.of({
        ...fs,
        rename: (source, destination) => destination.endsWith('models.generated.json')
          ? fs.rename(join(root, 'missing-derived-file'), destination)
          : fs.rename(source, destination)
      })
    })).pipe(Layer.provide(NodeFileSystem.layer))

    await withService(async (service) => {
      const profile = customProfile('recoverable')
      const error = await Effect.runPromise(Effect.flip(service.saveProfile(profile)))
      expect(error).toEqual(expect.objectContaining({
        _tag: 'ModelServiceError',
        reason: 'derived_config_unavailable',
        message: 'The generated model configuration could not be updated.'
      }))
      expect(JSON.stringify(error)).not.toContain('missing-derived-file')
      const persisted = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))
      expect(persisted.agent.modelProfiles).toEqual([profile])
      expect((await readdir(service.directory)).filter((name) => name.startsWith('.models-'))).toEqual([])
    }, makeRuntime(failingFilesystem))
  })
})
