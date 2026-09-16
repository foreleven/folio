import { NodeServices } from '@effect/platform-node'
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Stream } from 'effect'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { VaultRuntime } from './vault-runtime'
import { VaultContext } from './vault-context'
import { TaskService } from './task-service'
import { ConfigService } from './config-service'
import { VaultService } from './vault-service'
import { AgentRuntime } from './agent-runtime'
import { IntegrationService } from './integration-service'
import { ModelService } from './model-service'

it('builds reusable isolated Vault services without starting an Agent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'folio-vault-context-'))
  const runtime = ManagedRuntime.make(
    Layer.merge(VaultRuntime.layer, VaultService.layer).pipe(
      Layer.provide(AgentRuntime.layer(join(root, 'missing-agent-bundle'))),
      Layer.provide(ModelService.layer({ environment: {} })),
      Layer.provide(
        Layer.succeed(IntegrationService)({
          list: Effect.succeed([]),
          watch: Stream.empty,
          install: () => Effect.void,
          inspect: () => Effect.void,
          action: () => Effect.void,
          prepare: () => Effect.succeed({ skillPaths: [], executableDirectories: [], instructions: [] })
        })
      ),
      Layer.provideMerge(ConfigService.layer),
      Layer.provide(NodeServices.layer),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ FOLIO_CONFIG_DIR: join(root, 'config') })))
    )
  )
  try {
    await mkdir(join(root, 'a'))
    await mkdir(join(root, 'b'))
    await runtime.runPromise(
      Effect.gen(function* () {
        const vaults = yield* VaultService
        const registry = yield* VaultRuntime
        const a = yield* vaults.register(join(root, 'a'))
        const b = yield* vaults.register(join(root, 'b'))
        const first = yield* registry.open(a.id)
        const second = yield* registry.open(b.id)
        const tasks = Context.get(first, TaskService)
        expect(Context.get(first, VaultContext)).toMatchObject({ id: a.id, directory: join(root, 'config/vaults', a.id) })
        expect(Context.get(yield* registry.open(a.id), TaskService)).toBe(tasks)
        expect(Context.get(second, TaskService)).not.toBe(tasks)
        yield* tasks.saveRoutine({
          id: '11111111-1111-4111-8111-111111111111',
          expectedRevision: null,
          name: 'Only A',
          prompt: 'Review notes',
          agent: 'codex',
          model: null,
          skillIds: [],
          integrationIds: [],
          resourceIds: [],
          intervalMinutes: 60,
          timeZone: 'UTC',
          enabled: false
        })
        expect(yield* tasks.routines).toHaveLength(1)
        expect(yield* Context.get(second, TaskService).routines).toHaveLength(0)
        yield* (yield* ConfigService).removeVault(a.id)
        expect(yield* registry.open(a.id).pipe(Effect.flip)).toMatchObject({ reason: 'not-found' })
      })
    )
  } finally {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
