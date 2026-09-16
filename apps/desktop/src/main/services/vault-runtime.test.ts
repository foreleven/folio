import { DatabaseSync } from 'node:sqlite'
import { ExecutionEventLog } from './execution-event-log'
import { ExecutionNotifications } from './execution-scheduler'
import { NodeServices } from '@effect/platform-node'
import { ConfigProvider, Context, Effect, Fiber, Layer, ManagedRuntime, Stream } from 'effect'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { VaultRuntime } from './vault-runtime'
import { VaultContext } from './vault-context'
import { TaskService } from './task-service'
import { ConfigService } from './config-service'
import { VaultService } from './vault-service'
import { AgentRuntime } from './agent-runtime'
import { IntegrationService } from './integration-service'
import { ModelService } from './model-service'

function createRuntime(root: string, agent = AgentRuntime.layer(join(root, 'missing-agent-bundle'))) {
  return ManagedRuntime.make(
    Layer.merge(VaultRuntime.layer, VaultService.layer).pipe(
      Layer.provide(ExecutionNotifications.layer),
      Layer.provideMerge(ExecutionEventLog.layer),
      Layer.provide(agent),
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
}

it('builds reusable isolated Vault services without starting an Agent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'folio-vault-context-'))
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
        expect((yield* tasks.get(taskId)).runs).toEqual([])
        expect((yield* tasks.get(taskId)).task.worktreeState).toBe('pending')
        expect(yield* tasks.complete(taskId).pipe(Effect.flip)).toMatchObject({ reason: 'task-busy' })
        expect(yield* Context.get(second, TaskService).claimExecution('b-worker')).toBeNull()
        const claimed = yield* tasks.claimExecution('a-worker')
        expect(claimed?.id).toBe(runId)
        yield* tasks.executeRequest(claimed!)
        // Runtime discovery fails only inside the Worker, leaving a visible execution failure.
        const failed = yield* tasks.get(taskId)
        expect(failed.executions).toMatchObject([{ id: runId, state: 'failed', endedAt: expect.any(Number) }])
        expect(failed.runs).toEqual([])
        expect(yield* tasks.claimExecution('next-worker')).toBeNull()
        const routine = (yield* tasks.routines)[0]!
        yield* tasks.saveRoutine({ id: routine.id, name: routine.name, prompt: routine.prompt, agent: routine.agent,
          model: routine.model, skillIds: routine.skillIds, integrationIds: routine.integrationIds,
          intervalMinutes: routine.intervalMinutes, timeZone: routine.timeZone, expectedRevision: routine.revision, enabled: true })
        const routineIntent = { routineId: routine.id, requestId: '55555555-5555-4555-8555-555555555555' }
        const queuedRoutine = yield* tasks.runRoutine(routineIntent)
        expect(queuedRoutine.run.state).toBe('queued')
        expect(queuedRoutine.task.worktreeState).toBe('pending')
        expect(yield* tasks.runRoutine(routineIntent)).toEqual(queuedRoutine)
        const coalesced = yield* tasks.runRoutine({ routineId: routine.id })
        expect(coalesced.run.id).toBe(queuedRoutine.run.id)
        expect(coalesced.execution.windowEnd).toBe(queuedRoutine.execution.windowEnd)
        yield* tasks.cancelRun(queuedRoutine.task.id, queuedRoutine.run.id)
        expect((yield* tasks.runRoutine(routineIntent)).run.state).toBe('cancelled')
        expect(yield* tasks.claimExecution('after-cancellation')).toBeNull()
        yield* (yield* ConfigService).removeVault(a.id)
        expect(yield* registry.open(a.id).pipe(Effect.flip)).toMatchObject({ reason: 'not-found' })
      })
    )
  } finally {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(process.platform === 'win32')('executes queued requests through the real Agent process and joins cancellation before releasing ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'folio-queued-agent-'))
  const fixture = (await readFile(resolve('../../packages/agent/tests/fixtures/codex-app-server.mjs'), 'utf8'))
    .replace('id: "native-thread"', 'id: process.cwd()')
  await writeFile(join(root, 'codex'), `#!/usr/bin/env node\n${fixture}`, { mode: 0o700 })
  const runtime = createRuntime(root, Layer.succeed(AgentRuntime)({ get: Effect.succeed({
    nodeExecutable: process.execPath, entrypoint: resolve('../../packages/agent/dist/cli.js'),
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
      expect(success.executions).toMatchObject([{ state: 'succeeded' }])
      expect(success.runs).toMatchObject([{ state: 'succeeded' }])
      expect((yield* tasks.history(taskId, sessionId)).messages.some(message => message.kind === 'message')).toBe(true)
      const nextId = '99999999-9999-4999-8999-999999999999'
      yield* tasks.startRun({ id: nextId, taskId, sessionId, prompt: 'running', purpose: 'execution', resumesRunId: null })
      const worker = yield* tasks.executeRequest((yield* tasks.claimExecution('worker-cancel'))!).pipe(Effect.forkScoped)
      while (!(yield* tasks.get(taskId)).executions?.some(request => request.id === nextId && request.state === 'running')) {
        yield* Effect.sleep(20)
      }
      yield* tasks.cancelRun(taskId, nextId)
      yield* Fiber.join(worker)
      const cancelled = yield* tasks.get(taskId)
      expect(cancelled.executions?.find(request => request.id === nextId)).toMatchObject({ state: 'cancelled', endedAt: expect.any(Number) })
      expect(cancelled.runs.find(run => run.id === nextId)).toMatchObject({ state: 'cancelled' })
      expect(yield* tasks.claimExecution('after-cleanup')).toBeNull()
      const crashedId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
      yield* tasks.startRun({ id: crashedId, taskId, sessionId, prompt: 'crash', purpose: 'execution', resumesRunId: null })
      yield* tasks.executeRequest((yield* tasks.claimExecution('worker-crash'))!)
      expect((yield* tasks.get(taskId)).executions?.find(request => request.id === crashedId)).toMatchObject({ state: 'interrupted' })
      expect(yield* tasks.recoverExecutionState).toBe(0)
      expect(yield* tasks.claimExecution('no-automatic-retry')).toBeNull()
      expect(yield* (yield* ExecutionEventLog).unstoppedProcesses(vault.id)).toEqual([])
    }).pipe(Effect.scoped, Effect.timeout('20 seconds')))
  } finally {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 25000)

it('recovers a claim interrupted before process startup and preserves queued requests across application restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'folio-queue-restart-'))
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
      expect(yield* tasks.claimExecution('new-app')).toMatchObject({ id: queuedId })
      const detail = yield* tasks.get(taskId)
      expect(detail.executions).toMatchObject([
        { id: interruptedId, state: 'interrupted', owner: 'old-app' },
        { id: queuedId, state: 'preparing', owner: 'new-app' }
      ])
      expect(detail.runs).toEqual([])
      expect(detail.task.worktreeState).toBe('pending')
    }))
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('retains unreconciled live process ownership after restart instead of redispatching its Task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'folio-live-recovery-'))
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
      yield* tasks.claimExecution('old-app')
      yield* (yield* ExecutionEventLog).append({ eventId: 'old-app:process-started', vaultId, taskId, sessionId,
        runId, attemptId: 'old-app', payload: { _tag: 'process-started', pid: process.pid } })
    }))
    await runtime.dispose()
    runtime = createRuntime(root)
    await runtime.runPromise(Effect.gen(function* () {
      const tasks = Context.get(yield* (yield* VaultRuntime).open(vaultId), TaskService)
      expect(yield* tasks.recoverExecutionState).toBe(1)
      expect(yield* tasks.claimExecution('new-app')).toBeNull()
      expect((yield* tasks.get(taskId)).executions).toMatchObject([{ id: runId, state: 'preparing', owner: 'old-app', endedAt: null }])
      expect((yield* tasks.get(taskId)).runs).toEqual([])
    }))
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
})

it.skipIf(process.platform === 'win32').each(['run-finished', 'request-finished'] as const)(
  'recovers a missing %s receipt after real process cleanup without another Agent dispatch', async lostReceipt => {
    const root = await mkdtemp(join(tmpdir(), 'folio-terminal-recovery-'))
    const fixture = await readFile(resolve('../../packages/agent/tests/fixtures/codex-app-server.mjs'), 'utf8')
    await writeFile(join(root, 'codex'), `#!/usr/bin/env node\n${fixture}`, { mode: 0o700 })
    const agent = Layer.succeed(AgentRuntime)({ get: Effect.succeed({ nodeExecutable: process.execPath,
      entrypoint: resolve('../../packages/agent/dist/cli.js'), agentVersion: '0.1.0', codexExecutable: join(root, 'codex') }) })
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
        journal = new DatabaseSync(join(root, 'config', 'execution-events.db'))
        // The fixed fixture tag is the only interpolated value; no user SQL enters this trigger.
        journal.exec(`CREATE TRIGGER lose_terminal BEFORE INSERT ON execution_events
          WHEN json_extract(NEW.payload, '$._tag')='${lostReceipt}' BEGIN SELECT RAISE(ABORT, 'injected journal failure'); END`)
        expect(yield* tasks.executeRequest(request).pipe(Effect.exit)).toMatchObject({ _tag: 'Failure' })
        expect((yield* tasks.get(taskId)).executions?.[0]?.endedAt).toBeNull()
      }).pipe(Effect.timeout('20 seconds')))
      await runtime.dispose()
      journal!.exec('DROP TRIGGER lose_terminal')
      journal!.close(); journal = undefined
      runtime = createRuntime(root, agent)
      await runtime.runPromise(Effect.gen(function* () {
        const tasks = Context.get(yield* (yield* VaultRuntime).open(vaultId), TaskService)
        expect(yield* tasks.recoverExecutionState).toBe(0)
        const detail = yield* tasks.get(taskId)
        const outcome = lostReceipt === 'run-finished' ? 'interrupted' : 'succeeded'
        expect(detail.executions).toMatchObject([{ id: runId, state: outcome, endedAt: expect.any(Number) }])
        expect(detail.runs).toMatchObject([{ id: runId, state: outcome }])
        expect(yield* tasks.claimExecution('must-not-redispatch')).toBeNull()
        const events = yield* (yield* ExecutionEventLog).after(vaultId, 0)
        expect(events.filter(event => event.payload._tag === 'process-started')).toHaveLength(1)
        expect(events.filter(event => event.payload._tag === 'run-reserved')).toHaveLength(1)
      }).pipe(Effect.timeout('20 seconds')))
    } finally { journal?.close(); await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
  }, 30000
)
