import { AgentWorkerPool } from '../agent/agent-worker-pool'
import { DatabaseSync } from 'node:sqlite'
import { RunFileStore } from '../execution/run-files'
import { ExecutionNotifications } from '../execution/execution-scheduler'
import { NodeServices } from '@effect/platform-node'
import { ConfigProvider, Context, Deferred, Effect, Fiber, Layer, ManagedRuntime, Stream } from 'effect'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { VaultRuntime } from './vault-runtime'
import { VaultContext } from './vault-context'
import { TaskService } from '../tasks/task-service'
import { ConfigService } from '../config/config-service'
import { VaultService } from './vault-service'
import { AgentRuntime } from '../agent/agent-runtime'
import { IntegrationService } from '../integrations/integration-service'
import { ModelService } from '../models/model-service'
import type { IntegrationView } from '../../../shared/integration'
import { imap } from '@folio/integrations/imap'
import { routineTimestampAt } from '../../../shared/routine'

function createRuntime(
  root: string,
  agent = AgentRuntime.layer(join(root, 'missing-agent-bundle')),
  integrations: readonly IntegrationView[] = [],
  ingest: IntegrationService['Service']['ingest'] = () => Effect.void
) {
  return ManagedRuntime.make(
    Layer.merge(VaultRuntime.layer, VaultService.layer).pipe(
      Layer.provide(AgentWorkerPool.layer),
      Layer.provide(ExecutionNotifications.layer),
      Layer.provide(agent),
      Layer.provide(ModelService.layer({ environment: {} })),
      Layer.provide(
        Layer.succeed(IntegrationService)({
          list: Effect.succeed(integrations),
          watch: Stream.empty,
          install: () => Effect.void,
          inspect: () => Effect.void,
          action: () => Effect.void,
          prepare: () => Effect.succeed({ skillPaths: [], executableDirectories: [], instructions: [] }),
          ingest
        })
      ),
      Layer.provideMerge(ConfigService.layer),
      Layer.provide(NodeServices.layer),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ FOLIO_CONFIG_DIR: join(root, 'config') })))
    )
  )
}

const readyImap = (): IntegrationView => {
  const resources = imap.resources.map(({ id, type, name }) => ({ id, type, name }))
  return { ...imap, resources, busy: false,
    record: { id: 'imap', state: 'ready', data: {}, actions: [], resources, error: null, createdAt: 1, updatedAt: 1 } }
}

/** Keeps service tests near local midnight so successful ingestion does not start a long catch-up chain. */
const nearMidnightTimeZone = () => {
  const utcHour = new Date().getUTCHours()
  const offset = -utcHour
  return offset === 0 ? 'Etc/GMT' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`
}

const waitForIngestion = Effect.fnUntraced(function* (
  tasks: TaskService['Service'],
  taskId: string,
  states: ReadonlySet<string>
) {
  let last: unknown
  for (let attempt = 0; attempt < 500; attempt++) {
    const task = (yield* tasks.get(taskId)).task
    last = task
    if (task.type === 'ingestion' && states.has(task.receipt.state)) return task
    yield* Effect.sleep(20)
  }
  return yield* Effect.die(new Error(`Timed out waiting for Ingestion Task ${taskId}: ${JSON.stringify(last)}`))
})

it('creates one hourly IMAP Ingestion Routine after the resource is ready and preserves user edits', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'folio-imap-routine-')))
  const runtime = createRuntime(root, undefined, [readyImap()])
  try {
    await mkdir(join(root, 'vault'))
    await runtime.runPromise(Effect.gen(function* () {
      const vault = yield* (yield* VaultService).register(join(root, 'vault'))
      const context = yield* (yield* VaultRuntime).open(vault.id)
      const tasks = Context.get(context, TaskService)
      yield* tasks.ensureDefaultRoutine
      yield* tasks.ensureDefaultRoutine
      const routines = yield* tasks.routines
      expect(routines).toHaveLength(1)
      expect(routines[0]).toMatchObject({ type: 'ingestion', configuration: { integrationId: 'imap', resourceId: 'email' }, intervalMinutes: 60 })
      const routine = routines[0]!
      if (routine.type !== 'ingestion') throw new Error('Expected Ingestion Routine')
      yield* tasks.saveRoutine({ id: routine.id, expectedRevision: routine.revision, enabled: false, name: 'My mailbox',
        type: routine.type, configuration: routine.configuration, intervalMinutes: routine.intervalMinutes, timeZone: routine.timeZone })
      yield* tasks.ensureDefaultRoutine
      expect(yield* tasks.routines).toMatchObject([{ name: 'My mailbox', enabled: false }])
    }))
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('executes Ingestion without a Session and records changed raws at the canonical commit', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'folio-ingestion-success-')))
  let outputDirectory = ''
  let vaultId = ''
  const runtime = createRuntime(root, undefined, [readyImap()], (_integrationId, _resourceId, output, window) =>
    Effect.tryPromise(async () => {
      outputDirectory = output
      expect(window.timeZone).toBe(nearMidnightTimeZone())
      await mkdir(output, { recursive: true })
      await writeFile(join(output, 'message.md'), '# Message\n')
    }).pipe(Effect.orDie))
  try {
    await mkdir(join(root, 'vault'))
    await runtime.runPromise(Effect.gen(function* () {
      const vault = yield* (yield* VaultService).register(join(root, 'vault'))
      vaultId = vault.id
      const tasks = Context.get(yield* (yield* VaultRuntime).open(vault.id), TaskService)
      const routine = (yield* tasks.routines)[0]!
      if (routine.type !== 'ingestion') return yield* Effect.die(new Error('Expected Ingestion Routine'))
      yield* tasks.saveRoutine({ id: routine.id, name: routine.name, type: routine.type, configuration: routine.configuration,
        intervalMinutes: routine.intervalMinutes, timeZone: nearMidnightTimeZone(), enabled: routine.enabled, expectedRevision: routine.revision })
      const submitted = yield* tasks.runRoutine({ routineId: routine.id })
      expect(submitted.run).toBeNull()
      expect(yield* tasks.openSession({ taskId: submitted.task.id,
        sessionId: '33333333-3333-4333-8333-333333333333', agent: 'codex' }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      const completed = yield* waitForIngestion(tasks, submitted.task.id, new Set(['succeeded']))
      expect(completed.receipt).toMatchObject({ state: 'succeeded', attemptCount: 1,
        changeId: expect.any(String), observedHead: null })
      expect((yield* tasks.get(submitted.task.id)).sessions).toEqual([])
      expect((yield* tasks.get(submitted.task.id)).runs).toEqual([])
    }).pipe(Effect.timeout('20 seconds')))
    const rawNamespace = outputDirectory.slice(outputDirectory.indexOf(`${join('raws', 'imap', 'email')}`))
    expect(await readFile(join(root, 'config/vaults', vaultId, 'workspace', rawNamespace, 'message.md'), 'utf8')).toBe('# Message\n')
    await vi.waitFor(() => {
      const database = new DatabaseSync(join(root, 'config/vaults', vaultId, 'data.db'))
      try {
        expect(database.prepare('SELECT integration_id, resource_id, path, state, current_commit FROM raws').all()).toMatchObject([{
          integration_id: 'imap', resource_id: 'email', path: expect.stringMatching(/^raws\/imap\/email\/\d{4}-\d{2}-\d{2}\/message\.md$/),
          state: 'present', current_commit: expect.any(String)
        }])
      } finally { database.close() }
    })
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
}, 25_000)

it('advances a no-change Ingestion window without creating a raw row', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'folio-ingestion-empty-')))
  let vaultId = ''
  const runtime = createRuntime(root, undefined, [readyImap()])
  try {
    await mkdir(join(root, 'vault'))
    await runtime.runPromise(Effect.gen(function* () {
      const vault = yield* (yield* VaultService).register(join(root, 'vault'))
      vaultId = vault.id
      const tasks = Context.get(yield* (yield* VaultRuntime).open(vault.id), TaskService)
      const routine = (yield* tasks.routines)[0]!
      if (routine.type !== 'ingestion') return yield* Effect.die(new Error('Expected Ingestion Routine'))
      yield* tasks.saveRoutine({ id: routine.id, name: routine.name, type: routine.type, configuration: routine.configuration,
        intervalMinutes: routine.intervalMinutes, timeZone: nearMidnightTimeZone(), enabled: routine.enabled, expectedRevision: routine.revision })
      const submitted = yield* tasks.runRoutine({ routineId: routine.id })
      const completed = yield* waitForIngestion(tasks, submitted.task.id, new Set(['succeeded']))
      expect(completed.receipt).toMatchObject({ state: 'succeeded', attemptCount: 1,
        changeId: null, observedHead: expect.any(String) })
    }).pipe(Effect.timeout('20 seconds')))
    const database = new DatabaseSync(join(root, 'config/vaults', vaultId, 'data.db'))
    try { expect(database.prepare('SELECT id FROM raws').all()).toEqual([]) } finally { database.close() }
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
}, 25_000)

it('retries a failed Ingestion attempt on the same Task and exact window', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'folio-ingestion-retry-')))
  const windows: Array<{ start: number; end: number; timeZone: string }> = []
  let attempts = 0
  const runtime = createRuntime(root, undefined, [readyImap()], (_integrationId, _resourceId, output, window) => {
    attempts++
    windows.push(window)
    if (attempts === 1) return Effect.die(new Error('fixture provider failure'))
    return Effect.tryPromise(async () => {
      await mkdir(output, { recursive: true })
      await writeFile(join(output, 'retried.md'), 'retried\n')
    }).pipe(Effect.orDie)
  })
  try {
    await mkdir(join(root, 'vault'))
    await runtime.runPromise(Effect.gen(function* () {
      const vault = yield* (yield* VaultService).register(join(root, 'vault'))
      const tasks = Context.get(yield* (yield* VaultRuntime).open(vault.id), TaskService)
      const routine = (yield* tasks.routines)[0]!
      if (routine.type !== 'ingestion') return yield* Effect.die(new Error('Expected Ingestion Routine'))
      yield* tasks.saveRoutine({ id: routine.id, name: routine.name, type: routine.type, configuration: routine.configuration,
        intervalMinutes: routine.intervalMinutes, timeZone: nearMidnightTimeZone(), enabled: routine.enabled, expectedRevision: routine.revision })
      const submitted = yield* tasks.runRoutine({ routineId: routine.id })
      const failed = yield* waitForIngestion(tasks, submitted.task.id, new Set(['failed']))
      expect(failed.receipt).toMatchObject({ state: 'failed', attemptCount: 1 })
      expect((yield* tasks.routineExecutions(routine.id))).toMatchObject([{ taskId: submitted.task.id, status: 'failed' }])
      yield* tasks.retryIngestion(submitted.task.id)
      const completed = yield* waitForIngestion(tasks, submitted.task.id, new Set(['succeeded']))
      expect(completed.id).toBe(submitted.task.id)
      expect(completed.receipt).toMatchObject({ state: 'succeeded', attemptCount: 2 })
      expect(windows).toHaveLength(2)
      expect(windows[1]).toEqual(windows[0])
    }).pipe(Effect.timeout('20 seconds')))
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
}, 25_000)

it('cancels a running Ingestion without advancing its window', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'folio-ingestion-cancel-')))
  const runtime = createRuntime(root, undefined, [readyImap()], () => Effect.never)
  try {
    await mkdir(join(root, 'vault'))
    await runtime.runPromise(Effect.gen(function* () {
      const vault = yield* (yield* VaultService).register(join(root, 'vault'))
      const tasks = Context.get(yield* (yield* VaultRuntime).open(vault.id), TaskService)
      const routine = (yield* tasks.routines)[0]!
      if (routine.type !== 'ingestion') return yield* Effect.die(new Error('Expected Ingestion Routine'))
      yield* tasks.saveRoutine({ id: routine.id, name: routine.name, type: routine.type, configuration: routine.configuration,
        intervalMinutes: routine.intervalMinutes, timeZone: nearMidnightTimeZone(), enabled: routine.enabled, expectedRevision: routine.revision })
      const submitted = yield* tasks.runRoutine({ routineId: routine.id })
      yield* waitForIngestion(tasks, submitted.task.id, new Set(['running']))
      yield* tasks.cancelIngestion(submitted.task.id)
      const cancelled = yield* waitForIngestion(tasks, submitted.task.id, new Set(['cancelled']))
      expect(cancelled.receipt).toMatchObject({ state: 'cancelled', cancelRequested: true, attemptCount: 1 })
      expect(yield* tasks.routineExecutions(routine.id)).toMatchObject([{
        taskId: submitted.task.id, status: 'cancelled', cancelRequested: true,
        windowStart: submitted.execution.windowStart, windowEnd: submitted.execution.windowEnd
      }])
    }).pipe(Effect.timeout('20 seconds')))
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
}, 25_000)

it('rejects provider writes outside the exact dated raw namespace', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'folio-ingestion-namespace-')))
  const runtime = createRuntime(root, undefined, [readyImap()], (_integrationId, _resourceId, output) =>
    Effect.tryPromise(async () => {
      const worktree = resolve(output, '../../../..')
      await mkdir(join(worktree, 'wiki'), { recursive: true })
      await writeFile(join(worktree, 'wiki/provider-escape.md'), 'must not publish\n')
    }).pipe(Effect.orDie))
  try {
    await mkdir(join(root, 'vault'))
    await runtime.runPromise(Effect.gen(function* () {
      const vault = yield* (yield* VaultService).register(join(root, 'vault'))
      const tasks = Context.get(yield* (yield* VaultRuntime).open(vault.id), TaskService)
      const routine = (yield* tasks.routines)[0]!
      if (routine.type !== 'ingestion') return yield* Effect.die(new Error('Expected Ingestion Routine'))
      yield* tasks.saveRoutine({ id: routine.id, name: routine.name, type: routine.type, configuration: routine.configuration,
        intervalMinutes: routine.intervalMinutes, timeZone: nearMidnightTimeZone(), enabled: routine.enabled, expectedRevision: routine.revision })
      const submitted = yield* tasks.runRoutine({ routineId: routine.id })
      const failed = yield* waitForIngestion(tasks, submitted.task.id, new Set(['failed']))
      expect(failed.receipt).toMatchObject({ state: 'failed', changeId: null, observedHead: null })
      expect(yield* Effect.promise(() => readFile(join(root, 'config/vaults', vault.id, 'workspace/wiki/provider-escape.md'), 'utf8').catch(() => null))).toBeNull()
    }).pipe(Effect.timeout('20 seconds')))
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
}, 25_000)

it('retries a retained Ingestion conflict without invoking the provider again', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'folio-ingestion-conflict-')))
  let entered!: () => void
  let release!: () => void
  const providerEntered = new Promise<void>(resolveEntered => { entered = resolveEntered })
  const providerRelease = new Promise<void>(resolveRelease => { release = resolveRelease })
  let attempts = 0
  let outputDirectory = ''
  const runtime = createRuntime(root, undefined, [readyImap()], (_integrationId, _resourceId, output) => Effect.promise(async () => {
    attempts++
    outputDirectory = output
    await mkdir(output, { recursive: true })
    await writeFile(join(output, 'same.md'), 'provider version\n')
    entered()
    await providerRelease
  }))
  try {
    await mkdir(join(root, 'vault'))
    await runtime.runPromise(Effect.gen(function* () {
      const vault = yield* (yield* VaultService).register(join(root, 'vault'))
      const tasks = Context.get(yield* (yield* VaultRuntime).open(vault.id), TaskService)
      const routine = (yield* tasks.routines)[0]!
      if (routine.type !== 'ingestion') return yield* Effect.die(new Error('Expected Ingestion Routine'))
      yield* tasks.saveRoutine({ id: routine.id, name: routine.name, type: routine.type, configuration: routine.configuration,
        intervalMinutes: routine.intervalMinutes, timeZone: nearMidnightTimeZone(), enabled: routine.enabled, expectedRevision: routine.revision })
      const submitted = yield* tasks.runRoutine({ routineId: routine.id })
      yield* Effect.promise(() => providerEntered)
      const relative = `${outputDirectory.slice(outputDirectory.indexOf(join('raws', 'imap', 'email')))}/same.md`
      const workspace = join(root, 'config/vaults', vault.id, 'workspace')
      yield* Effect.promise(async () => {
        await mkdir(join(workspace, relative, '..'), { recursive: true })
        await writeFile(join(workspace, relative), 'canonical version\n')
      })
      const initial = yield* tasks.workspace.inspect
      yield* tasks.saveWorkspaceFiles({ id: 'conflicting-main-save', expectedParent: initial.head, paths: [relative] })
      release()
      const conflicted = yield* waitForIngestion(tasks, submitted.task.id, new Set(['conflict']))
      expect(conflicted.receipt).toMatchObject({ state: 'conflict', changeId: expect.any(String) })
      expect(attempts).toBe(1)

      yield* Effect.promise(() => rm(join(workspace, relative)))
      const current = yield* tasks.workspace.inspect
      yield* tasks.saveWorkspaceFiles({ id: 'remove-conflicting-main-save', expectedParent: current.head, paths: [relative] })
      yield* tasks.retryIngestion(submitted.task.id)
      const completed = yield* waitForIngestion(tasks, submitted.task.id, new Set(['succeeded']))
      expect(completed.receipt).toMatchObject({ state: 'succeeded', attemptCount: 2, changeId: conflicted.receipt.changeId })
      expect(attempts).toBe(1)
      expect(yield* Effect.promise(() => readFile(join(workspace, relative), 'utf8'))).toBe('provider version\n')
    }).pipe(Effect.timeout('30 seconds')))
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
}, 35_000)

it('keeps Routine admission and retries on the reserved Task revision after edits', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'folio-routine-revision-')))
  const runtime = createRuntime(root)
  try {
    await mkdir(join(root, 'wiki'))
    await runtime.runPromise(Effect.gen(function* () {
      const vault = yield* (yield* VaultService).register(join(root, 'wiki'))
      const tasks = Context.get(yield* (yield* VaultRuntime).open(vault.id), TaskService)
      const input = { id: '11111111-1111-4111-8111-111111111111', expectedRevision: null,
        name: 'Original', type: 'agent' as const, configuration: { goal: 'Original prompt', agent: 'codex' as const, model: null,
          skillIds: [], integrationIds: [], resourceIds: [] }, intervalMinutes: 60, timeZone: 'Asia/Shanghai', enabled: true }
      yield* tasks.saveRoutine(input)
      const reserved = yield* tasks.prepareRoutine({ routineId: input.id })
      yield* tasks.saveRoutine({ ...input, expectedRevision: 1, configuration: { ...input.configuration, goal: 'Edited prompt' } })
      const submitted = yield* tasks.runRoutine({ routineId: input.id })
      expect(submitted.task).toEqual(reserved.task)
      expect(submitted.execution.routineRevision).toBe(1)
      expect(submitted.run!.prompt).toMatch(/^Original prompt\n/)
      expect(submitted.run!.prompt).toContain('- time-zone: Asia/Shanghai')
      expect(submitted.run!.prompt).toContain(`- start: ${routineTimestampAt(submitted.execution.windowStart!, input.timeZone)}`)
      expect(submitted.run!.prompt).toContain(`- end: ${routineTimestampAt(submitted.execution.windowEnd!, input.timeZone)}`)
      expect((yield* tasks.get(reserved.task.id)).sessions).toMatchObject([{ agent: 'codex', modelProfile: null }])
      expect((yield* tasks.runRoutine({ routineId: input.id })).run!.id).toBe(submitted.run!.id)
      yield* tasks.cancelRun(reserved.task.id, submitted.run!.id)
      const retry = yield* tasks.runRoutine({ routineId: input.id })
      expect(retry.task.id).not.toBe(reserved.task.id)
      expect(retry.run!.id).not.toBe(submitted.run!.id)
      expect(retry.run!.prompt).toMatch(/^Edited prompt\n/)
      yield* tasks.cancelRun(reserved.task.id, submitted.run!.id)
      expect((yield* tasks.runRoutine({ routineId: input.id })).run!.id).toBe(retry.run!.id)
      yield* tasks.cancelRun(retry.task.id, retry.run!.id)
    }))
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('builds reusable isolated Vault services without starting an Agent', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'folio-vault-context-')))
  const runtime = createRuntime(root)
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
          type: 'agent',
          configuration: { goal: 'Review notes', agent: 'codex', model: null, skillIds: [], integrationIds: [], resourceIds: [] },
          intervalMinutes: 60,
          timeZone: 'UTC',
          enabled: false
        })
        expect(yield* tasks.routines).toHaveLength(1)
        expect(yield* Context.get(second, TaskService).routines).toHaveLength(0)
        const taskId = '22222222-2222-4222-8222-222222222222'
        const sessionId = '33333333-3333-4333-8333-333333333333'
        const runId = '44444444-4444-4444-8444-444444444444'
        const task = yield* tasks.create({ id: taskId, goal: 'Offline admission', agent: 'codex' })
        expect(task.worktreeState).toBe('pending')
        expect(yield* tasks.openSession({ taskId, sessionId, agent: 'codex' })).toMatchObject({ acpSessionId: null })
        const intent = { id: runId, taskId, sessionId, prompt: 'Read notes', purpose: 'execution' as const, resumesRunId: null }
        const admitted = yield* tasks.startRun(intent)
        expect(admitted.state).toBe('queued')
        expect(yield* tasks.startRun(intent)).toEqual(admitted)
        expect((yield* tasks.get(taskId)).runs).toHaveLength(1)
        expect((yield* tasks.get(taskId)).task.worktreeState).toBe('pending')
        expect(yield* tasks.complete(taskId).pipe(Effect.flip)).toMatchObject({ reason: 'task-busy' })
        expect(yield* Context.get(second, TaskService).claimExecution('b-worker')).toBeNull()
        const claimed = yield* tasks.claimExecution('a-worker')
        expect(claimed?.id).toBe(runId)
        yield* tasks.executeRequest(claimed!)
        // Runtime discovery fails only inside the Worker, leaving a visible execution failure.
        const failed = yield* tasks.get(taskId)
        expect(failed.runs).toMatchObject([{ id: runId, state: 'failed', endedAt: expect.any(Number) }])
        expect(failed.runs).toMatchObject([{ state: 'failed', baselineCommit: null }])
        expect(yield* tasks.claimExecution('next-worker')).toBeNull()
        const routine = (yield* tasks.routines)[0]!
        if (routine.type !== 'agent') throw new Error('Expected Agent Routine')
        yield* tasks.saveRoutine({ id: routine.id, name: routine.name, type: routine.type, configuration: routine.configuration,
          intervalMinutes: routine.intervalMinutes, timeZone: routine.timeZone, expectedRevision: routine.revision, enabled: true })
        const routineIntent = { routineId: routine.id, requestId: '55555555-5555-4555-8555-555555555555' }
        const queuedRoutine = yield* tasks.runRoutine(routineIntent)
        expect(queuedRoutine.run!.state).toBe('queued')
        expect(queuedRoutine.task.worktreeState).toBe('pending')
        expect(yield* tasks.runRoutine(routineIntent)).toEqual(queuedRoutine)
        const coalesced = yield* tasks.runRoutine({ routineId: routine.id })
        expect(coalesced.run!.id).toBe(queuedRoutine.run!.id)
        expect(coalesced.execution.windowEnd).toBe(queuedRoutine.execution.windowEnd)
        expect(yield* tasks.cancelRun(taskId, queuedRoutine.run!.id).pipe(Effect.flip)).toMatchObject({ reason: 'not-found' })
        expect((yield* tasks.get(queuedRoutine.task.id)).runs[0]?.cancelRequested).toBe(false)
        yield* tasks.cancelRun(queuedRoutine.task.id, queuedRoutine.run!.id)
        expect((yield* tasks.runRoutine(routineIntent)).run!.state).toBe('cancelled')
        const followUp = yield* tasks.claimExecution('after-cancellation')
        expect(followUp?.source).toBe('routine')
        if (followUp) {
          yield* tasks.cancelRun(followUp.taskId, followUp.id)
          yield* tasks.executeRequest(followUp)
        }
        yield* (yield* ConfigService).removeVault(a.id)
        expect(yield* registry.open(a.id).pipe(Effect.flip)).toMatchObject({ reason: 'not-found' })
      })
    )
  } finally {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(process.platform === 'win32')('executes queued requests through the real Agent Worker and joins cancellation before releasing ownership', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'folio-queued-agent-')))
  const fixture = (await readFile(resolve('../../packages/agent/tests/fixtures/codex-app-server.mjs'), 'utf8'))
    .replace('id: "native-thread"', 'id: process.cwd()')
  await writeFile(join(root, 'codex'), `#!/usr/bin/env node\n${fixture}`, { mode: 0o700 })
  const runtime = createRuntime(root, Layer.succeed(AgentRuntime)({ get: Effect.succeed({
    entrypoint: resolve('out/main/agent-worker.js'),
    agentVersion: '0.1.0', codexExecutable: join(root, 'codex')
  }) }))
  try {
    await mkdir(join(root, 'wiki'))
    await runtime.runPromise(Effect.gen(function* () {
      const vault = yield* (yield* VaultService).register(join(root, 'wiki'))
      const tasks = Context.get(yield* (yield* VaultRuntime).open(vault.id), TaskService)
      const taskId = '66666666-6666-4666-8666-666666666666'
      const sessionId = '77777777-7777-4777-8777-777777777777'
      const runId = '88888888-8888-4888-8888-888888888888'
      yield* tasks.create({ id: taskId, goal: 'Exercise process receipt', agent: 'codex' })
      yield* tasks.openSession({ taskId, sessionId, agent: 'codex' })
      yield* tasks.startRun({ id: runId, taskId, sessionId, prompt: 'early-completion', purpose: 'execution', resumesRunId: null })
      yield* tasks.executeRequest((yield* tasks.claimExecution('worker-success'))!)
      const success = yield* tasks.get(taskId)
      expect(success.runs).toMatchObject([{ state: 'succeeded' }])
      expect(success.runs).toMatchObject([{ state: 'succeeded' }])
      expect((yield* tasks.history(taskId, sessionId)).messages.some(message => message.payload.kind === 'message')).toBe(true)
      const nextId = '99999999-9999-4999-8999-999999999999'
      yield* tasks.startRun({ id: nextId, taskId, sessionId, prompt: 'running', purpose: 'execution', resumesRunId: null })
      const worker = yield* tasks.executeRequest((yield* tasks.claimExecution('worker-cancel'))!).pipe(Effect.forkScoped)
      while (!(yield* tasks.get(taskId)).runs?.some(request => request.id === nextId && request.state === 'running')) {
        yield* Effect.sleep(20)
      }
      yield* tasks.cancelRun(taskId, nextId)
      yield* Fiber.join(worker)
      const cancelled = yield* tasks.get(taskId)
      expect(cancelled.runs?.find(request => request.id === nextId)).toMatchObject({ state: 'cancelled', endedAt: expect.any(Number) })
      expect(cancelled.runs.find(run => run.id === nextId)).toMatchObject({ state: 'cancelled' })
      expect(yield* tasks.claimExecution('after-cleanup')).toBeNull()
      const crashedId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
      yield* tasks.startRun({ id: crashedId, taskId, sessionId, prompt: 'crash', purpose: 'execution', resumesRunId: null })
      yield* tasks.executeRequest((yield* tasks.claimExecution('worker-crash'))!)
      expect((yield* tasks.get(taskId)).runs?.find(request => request.id === crashedId)).toMatchObject({ state: 'interrupted' })
      expect(yield* tasks.recoverExecutionState).toBe(0)
      expect(yield* tasks.claimExecution('no-automatic-retry')).toBeNull()
      yield* Effect.promise(() => expect(readFile(join(root, 'config', 'execution-events.db'))).rejects.toMatchObject({ code: 'ENOENT' }))
      expect(yield* Effect.promise(() => new RunFileStore(join(root, 'config', 'vaults', vault.id), vault.id).list())).toEqual([])
    }).pipe(Effect.scoped, Effect.timeout('20 seconds')))
  } finally {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 25000)

it('retains a claim with a missing recovery file and preserves queued requests across restart', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'folio-queue-restart-')))
  let runtime = createRuntime(root)
  let vaultId = ''
  const taskId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const interruptedId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const queuedId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  try {
    await mkdir(join(root, 'wiki'))
    await runtime.runPromise(Effect.gen(function* () {
      const vault = yield* (yield* VaultService).register(join(root, 'wiki'))
      vaultId = vault.id
      const tasks = Context.get(yield* (yield* VaultRuntime).open(vault.id), TaskService)
      yield* tasks.create({ id: taskId, goal: 'Survive restart', agent: 'codex' })
      yield* tasks.openSession({ taskId, sessionId, agent: 'codex' })
      for (const id of [interruptedId, queuedId]) yield* tasks.startRun({ id, taskId, sessionId, prompt: 'notes', purpose: 'execution', resumesRunId: null })
      expect(yield* tasks.claimExecution('old-app')).toMatchObject({ id: interruptedId })
      // Simulate shutdown/crash between durable claim and starting the Worker.
    }))
    await runtime.dispose()
    runtime = createRuntime(root)
    await runtime.runPromise(Effect.gen(function* () {
      const tasks = Context.get(yield* (yield* VaultRuntime).open(vaultId), TaskService)
      expect(yield* tasks.claimExecution('new-app')).toBeNull()
      const detail = yield* tasks.get(taskId)
      expect(detail.runs).toMatchObject([
        { id: interruptedId, state: 'preparing', owner: 'old-app' },
        { id: queuedId, state: 'queued', owner: null }
      ])
      expect(detail.runs).toHaveLength(2)
      expect(detail.task.worktreeState).toBe('pending')
    }))
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('retains unreconciled live process ownership after restart instead of redispatching its Task', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'folio-live-recovery-')))
  let runtime = createRuntime(root)
  let vaultId = ''
  const taskId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const runId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  try {
    await mkdir(join(root, 'wiki'))
    await runtime.runPromise(Effect.gen(function* () {
      vaultId = (yield* (yield* VaultService).register(join(root, 'wiki'))).id
      const tasks = Context.get(yield* (yield* VaultRuntime).open(vaultId), TaskService)
      yield* tasks.create({ id: taskId, goal: 'Do not steal live ownership', agent: 'codex' })
      yield* tasks.openSession({ taskId, sessionId, agent: 'codex' })
      yield* tasks.startRun({ id: runId, taskId, sessionId, prompt: 'notes', purpose: 'execution', resumesRunId: null })
      const run = (yield* tasks.claimExecution('old-app'))!
      const directory = Context.get(yield* (yield* VaultRuntime).open(vaultId), VaultContext).directory
      const files = new RunFileStore(directory, vaultId)
      yield* Effect.promise(() => files.begin(run))
      yield* Effect.promise(() => files.update(run.id, 'old-app', state => ({ ...state,
        processes: [{ pid: process.pid, stopped: false }] })))
    }))
    await runtime.dispose()
    runtime = createRuntime(root)
    await runtime.runPromise(Effect.gen(function* () {
      const tasks = Context.get(yield* (yield* VaultRuntime).open(vaultId), TaskService)
      expect(yield* tasks.recoverExecutionState).toBe(1)
      expect(yield* tasks.claimExecution('new-app')).toBeNull()
      expect((yield* tasks.get(taskId)).runs).toMatchObject([{ id: runId, state: 'preparing', owner: 'old-app', endedAt: null }])
      expect((yield* tasks.get(taskId)).runs).toHaveLength(1)
    }))
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
})

it.skipIf(process.platform === 'win32')(
  'recovers a failed terminal database commit after real process cleanup without another Agent dispatch', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'folio-terminal-recovery-')))
    const fixture = await readFile(resolve('../../packages/agent/tests/fixtures/codex-app-server.mjs'), 'utf8')
    await writeFile(join(root, 'codex'), `#!/usr/bin/env node\n${fixture}`, { mode: 0o700 })
    const agent = Layer.succeed(AgentRuntime)({ get: Effect.succeed({
      entrypoint: resolve('out/main/agent-worker.js'), agentVersion: '0.1.0', codexExecutable: join(root, 'codex') }) })
    let runtime = createRuntime(root, agent)
    let vaultId = ''
    const taskId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const runId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    let journal: DatabaseSync | undefined
    try {
      await mkdir(join(root, 'wiki'))
      await runtime.runPromise(Effect.gen(function* () {
        vaultId = (yield* (yield* VaultService).register(join(root, 'wiki'))).id
        const tasks = Context.get(yield* (yield* VaultRuntime).open(vaultId), TaskService)
        yield* tasks.create({ id: taskId, goal: 'Recover terminal receipt', agent: 'codex' })
        yield* tasks.openSession({ taskId, sessionId, agent: 'codex' })
        yield* tasks.startRun({ id: runId, taskId, sessionId, prompt: 'early-completion', purpose: 'execution', resumesRunId: null })
        const request = (yield* tasks.claimExecution('original-worker'))!
        journal = new DatabaseSync(join(Context.get(yield* (yield* VaultRuntime).open(vaultId), VaultContext).directory, 'data.db'))
        journal.exec(`CREATE TRIGGER lose_terminal BEFORE UPDATE OF state ON runs
          WHEN NEW.state='succeeded' BEGIN SELECT RAISE(ABORT, 'injected commit failure'); END`)
        expect(yield* tasks.executeRequest(request).pipe(Effect.exit)).toMatchObject({ _tag: 'Failure' })
        expect((yield* tasks.get(taskId)).runs?.[0]?.endedAt).toBeNull()
      }).pipe(Effect.timeout('20 seconds')))
      await runtime.dispose()
      journal!.exec('DROP TRIGGER lose_terminal')
      journal!.close(); journal = undefined
      runtime = createRuntime(root, agent)
      await runtime.runPromise(Effect.gen(function* () {
        const tasks = Context.get(yield* (yield* VaultRuntime).open(vaultId), TaskService)
        expect(yield* tasks.recoverExecutionState).toBe(0)
        const detail = yield* tasks.get(taskId)
        const outcome = 'succeeded'
        expect(detail.runs).toMatchObject([{ id: runId, state: outcome, endedAt: expect.any(Number) }])
        expect(detail.runs).toMatchObject([{ id: runId, state: outcome }])
        expect(yield* tasks.claimExecution('must-not-redispatch')).toBeNull()
        const directory = Context.get(yield* (yield* VaultRuntime).open(vaultId), VaultContext).directory
        const log = yield* Effect.promise(() => readFile(join(directory, 'logs', 'runs', runId, 'original-worker.jsonl'), 'utf8'))
        expect(log.split('\n').filter(line => line && JSON.parse(line).event === 'process-started')).toHaveLength(1)
      }).pipe(Effect.timeout('20 seconds')))
    } finally { journal?.close(); await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
  }, 30000
)

it('retires old services before deletion, allows other Vaults, and recovers from a failed deletion callback', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'folio-vault-retire-')))
  const closedFiles: Array<string | null> = []
  const originalClose = DatabaseSync.prototype.close
  const closeDatabase = vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(function (this: DatabaseSync) {
    closedFiles.push(this.location())
    originalClose.call(this)
  })
  const runtime = createRuntime(root)
  try {
    await mkdir(join(root, 'a'))
    await mkdir(join(root, 'b'))
    await runtime.runPromise(Effect.gen(function* () {
      const vaults = yield* VaultService
      const registry = yield* VaultRuntime
      const config = yield* ConfigService
      const a = yield* vaults.register(join(root, 'a'))
      const b = yield* vaults.register(join(root, 'b'))
      const stale = Context.get(yield* registry.open(a.id), TaskService)
      const other = Context.get(yield* registry.open(b.id), TaskService)
      expect(yield* registry.withClosed(a.id, Effect.fail('fixture delete failure')).pipe(Effect.flip)).toBe('fixture delete failure')
      expect(yield* stale.list.pipe(Effect.flip)).toMatchObject({ reason: 'task-busy' })
      const fresh = Context.get(yield* registry.open(a.id), TaskService)
      expect(fresh).not.toBe(stale)
      const closedBefore = closedFiles.length
      yield* registry.withClosed(a.id, Effect.gen(function* () {
        expect(closedFiles.slice(closedBefore)).toContain(join(root, 'config/vaults', a.id, 'data.db'))
        expect(closedFiles.slice(closedBefore)).not.toContain(join(root, 'config/vaults', b.id, 'data.db'))
        expect(yield* fresh.list.pipe(Effect.flip)).toMatchObject({ reason: 'task-busy' })
        expect(yield* other.list).toEqual([])
        yield* vaults.remove(a)
        yield* config.removeVault(a.id)
      }))
      expect(yield* registry.open(a.id).pipe(Effect.flip)).toMatchObject({ reason: 'not-found' })
      expect(yield* other.list).toEqual([])
    }))
  } finally { await runtime.dispose(); closeDatabase.mockRestore(); await rm(root, { recursive: true, force: true }) }
})


it('serializes reopening with deletion and rejects deletion while a claimed Run is unverified', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'folio-vault-retire-race-')))
  const runtime = createRuntime(root)
  try {
    await mkdir(join(root, 'a'))
    await runtime.runPromise(Effect.gen(function* () {
      const vaults = yield* VaultService
      const registry = yield* VaultRuntime
      const a = yield* vaults.register(join(root, 'a'))
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let reopened = false
      const deletion = yield* registry.withClosed(a.id, Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)))).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const opener = yield* registry.open(a.id).pipe(Effect.tap(() => Effect.sync(() => { reopened = true })), Effect.forkChild)
      yield* Effect.yieldNow
      expect(reopened).toBe(false)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(deletion)
      const tasks = Context.get(yield* Fiber.join(opener), TaskService)
      const taskId = '22222222-2222-4222-8222-222222222222'
      const sessionId = '33333333-3333-4333-8333-333333333333'
      yield* tasks.create({ id: taskId, goal: 'read', agent: 'codex' })
      yield* tasks.openSession({ taskId, sessionId, agent: 'codex' })
      yield* tasks.startRun({ id: '44444444-4444-4444-8444-444444444444', taskId, sessionId, prompt: 'read', purpose: 'execution', resumesRunId: null })
      yield* tasks.claimExecution('not-started')
      let deleted = false
      expect(yield* registry.withClosed(a.id, Effect.sync(() => { deleted = true })).pipe(Effect.flip)).toMatchObject({ reason: 'task-busy' })
      expect(deleted).toBe(false)
      expect((yield* tasks.get(taskId)).runs[0]?.state).toBe('preparing')
    }))
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
})

it.skipIf(process.platform === 'win32')('stops a live Agent and joins its receipt before deleting Vault files', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'folio-delete-live-agent-')))
  const fixture = await readFile(resolve('../../packages/agent/tests/fixtures/codex-app-server.mjs'), 'utf8')
  await writeFile(join(root, 'codex'), `#!/usr/bin/env node\n${fixture}`, { mode: 0o700 })
  const runtime = createRuntime(root, Layer.succeed(AgentRuntime)({ get: Effect.succeed({
    entrypoint: resolve('out/main/agent-worker.js'), agentVersion: '0.1.0', codexExecutable: join(root, 'codex') }) }))
  try {
    await mkdir(join(root, 'wiki'))
    await runtime.runPromise(Effect.gen(function* () {
      const vaults = yield* VaultService
      const registry = yield* VaultRuntime
      const config = yield* ConfigService
      const vault = yield* vaults.register(join(root, 'wiki'))
      const context = yield* registry.open(vault.id)
      const tasks = Context.get(context, TaskService)
      const directory = Context.get(context, VaultContext).directory
      const taskId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      const runId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
      yield* tasks.create({ id: taskId, goal: 'running', agent: 'codex' })
      yield* tasks.openSession({ taskId, sessionId, agent: 'codex' })
      yield* tasks.startRun({ id: runId, taskId, sessionId, prompt: 'running', purpose: 'execution', resumesRunId: null })
      const request = (yield* tasks.claimExecution('deletion-worker'))!
      const worker = yield* tasks.executeRequest(request).pipe(Effect.forkChild)
      while ((yield* tasks.get(taskId)).runs[0]?.state !== 'running') yield* Effect.sleep(10)
      const files = new RunFileStore(directory, vault.id)
      const pids = (yield* Effect.promise(() => files.list())).flatMap(state => state.processes.map(native => native.pid))
      expect(pids.length).toBeGreaterThan(0)
      yield* registry.withClosed(vault.id, Effect.gen(function* () {
        expect(yield* Effect.promise(() => files.list())).toEqual([])
        for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
        yield* vaults.remove(vault)
        yield* config.removeVault(vault.id)
      }))
      yield* Fiber.await(worker)
      expect(yield* tasks.list.pipe(Effect.flip)).toMatchObject({ reason: 'task-busy' })
      expect((yield* config.get).vaults).toEqual([])
    }).pipe(Effect.timeout('20 seconds')))
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
}, 30000)
