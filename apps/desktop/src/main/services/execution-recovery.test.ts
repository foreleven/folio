import { Effect, Layer } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { recoverExecutions } from './execution-recovery'
import { ExecutionEventSink } from './execution-event-sink'
import { ExecutionQueue } from './execution-queue'
import { HarnessStore } from './harness-store'
import { HarnessEventStore } from './harness-event-store'
import type { HarnessSessions } from './harness-sessions'
import type { HarnessRuns } from './harness-runs'
import type { AgentWorkerPool } from './agent-worker-pool'
import { RunFiles, fileEffect } from './run-files'
import { VaultContext } from './vault-context'
import { vaultDatabaseLayer } from './vault-database'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'folio-file-recovery-')) })
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
const layer = () => ExecutionEventSink.layer.pipe(
  Layer.provideMerge(RunFiles.layer),
  Layer.provideMerge(Layer.mergeAll(HarnessStore.layer, HarnessEventStore.layer, ExecutionQueue.layer)),
  Layer.provideMerge(vaultDatabaseLayer(root)),
  Layer.provide(Layer.succeed(VaultContext)({ id: 'vault', directory: root, vault: { id: 'vault', name: 'Vault', path: root } }))
)
const setup = Effect.gen(function* () {
  const store = yield* HarnessStore
  const queue = yield* ExecutionQueue
  const sink = yield* ExecutionEventSink
  const files = yield* RunFiles
  yield* store.createTask({ id: 'task', goal: 'Test', branch: 'task', worktree: '/test', configuration: { agent: 'codex', skillIds: [], integrationIds: [] } })
  yield* store.createSession({ id: 'session', taskId: 'task', agent: 'codex', adapterVersion: '1', purpose: 'task', syncOperationId: null })
  for (const id of ['first', 'next']) yield* queue.submit({ id, taskId: 'task', sessionId: 'session', prompt: 'Never auto replay', purpose: 'execution', resumesRunId: null, source: 'manual' })
  const run = (yield* queue.claim('owner'))!
  yield* sink.begin(run)
  let archivesRead = 0
  const sessions: HarnessSessions['Service'] = {
    open: () => Effect.die('Recovery must not open an Agent'), close: () => Effect.void,
    hasLiveTask: () => Effect.succeed(false),
    withStoppedSession: (_task, _session, action) => Effect.gen(function* () { archivesRead++; return yield* action([]) })
  }
  const runs: HarnessRuns['Service'] = {
    execute: () => Effect.die('Recovery must not send a prompt'), cancel: () => Effect.die('Recovery must not cancel by an unverified PID'),
    inspect: (_taskId, id) => sink.finishRun(id, 'interrupted').pipe(Effect.andThen(queue.get(id)))
  }
  const workers: AgentWorkerPool['Service'] = {
    acquire: async () => { throw new Error('Recovery must not launch a Worker') }, reconcile: async () => {}, hasThread: () => false
  }
  const recover = recoverExecutions({ workers, owned: new Set(), queue, sink, store, runs, sessions, files })
  return { store, queue, sink, files, run, recover, archivesRead: () => archivesRead }
})

it('recovers a claimed receipt before Worker creation without replaying its prompt', async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const { queue, recover } = yield* setup
    yield* recover
    expect(yield* queue.get('first')).toMatchObject({ state: 'interrupted', endedAt: expect.any(Number) })
    expect(yield* queue.claim('next-owner')).toMatchObject({ id: 'next' })
  }).pipe(Effect.provide(layer())))
})

it('retains the spawn-before-registration window and a missing state file', async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const { files, queue, recover } = yield* setup
    yield* fileEffect(() => files.update('first', 'owner', state => ({ ...state, ownerPid: 2147483647, threadId: null, workerStopped: false, phase: 'starting' })))
    yield* recover
    expect(yield* queue.claim('must-not-start')).toBeNull()
    yield* Effect.promise(() => rm(join(root, 'runtime/runs/first/owner'), { recursive: true }))
    yield* recover
    expect(yield* queue.get('first')).toMatchObject({ state: 'preparing', endedAt: null })
    expect(yield* queue.claim('must-not-start')).toBeNull()
  }).pipe(Effect.provide(layer())))
})

it('recovers a binding and successful result saved before SQL commit, then cleans terminal leftovers', async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const { files, store, queue, recover, archivesRead } = yield* setup
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE runs SET baseline_commit='verified' WHERE id='first'`
    yield* fileEffect(() => files.update('first', 'owner', state => ({ ...state, ownerPid: 2147483647,
      threadId: 1, workerStopped: false, phase: 'active', processes: [{ pid: 2147483646, stopped: false }],
      binding: { acpSessionId: 'acp', nativeSessionId: 'native' }, result: { outcome: 'succeeded', error: null } })))
    const receipt = (yield* fileEffect(() => files.read('first', 'owner')))!
    yield* recover
    expect((yield* store.sessions('task'))[0]).toMatchObject({ acpSessionId: 'acp', nativeSessionId: 'native' })
    expect(yield* queue.get('first')).toMatchObject({ state: 'succeeded' })
    expect(archivesRead()).toBe(1)
    // Crash after terminal commit and before unlink: restoring the leftover cannot rerun work.
    yield* Effect.promise(async () => {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(root, 'runtime/runs/first/owner'), { recursive: true })
      await writeFile(join(root, 'runtime/runs/first/owner/state.json'), JSON.stringify({ ...receipt, workerStopped: true, processes: [] }))
    })
    yield* recover
    expect(yield* fileEffect(() => files.read('first', 'owner'))).toBeNull()
    expect(yield* queue.get('first')).toMatchObject({ state: 'succeeded' })
  }).pipe(Effect.provide(layer())))
})

it('does not release a still-live native process', async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const { files, queue, recover } = yield* setup
    yield* fileEffect(() => files.update('first', 'owner', state => ({ ...state,
      processes: [{ pid: process.pid, stopped: false }], result: { outcome: 'failed', error: null } })))
    yield* recover
    expect(yield* queue.get('first')).toMatchObject({ state: 'preparing', endedAt: null })
    expect(yield* queue.claim('must-not-start')).toBeNull()
  }).pipe(Effect.provide(layer())))
})

it('rejects corrupt or orphan receipts instead of inferring free capacity', async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const { files, queue, recover } = yield* setup
    yield* fileEffect(() => files.update('first', 'owner', state => ({ ...state, result: { outcome: 'failed', error: null } })))
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE runs SET owner='new-owner' WHERE id='first'`
    expect((yield* recover.pipe(Effect.exit))._tag).toBe('Failure')
    yield* Effect.promise(() => writeFile(join(root, 'runtime/runs/first/owner/state.json'), '{broken'))
    expect((yield* recover.pipe(Effect.exit))._tag).toBe('Failure')
    expect((yield* queue.get('first')).endedAt).toBeNull()
  }).pipe(Effect.provide(layer())))
})

it.skipIf(process.platform === 'win32')('never signals a reused PID and only releases the old execution after its group is gone', async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const { files, queue, recover } = yield* setup
    const kill = vi.spyOn(process, 'kill')
    yield* fileEffect(() => files.update('first', 'owner', state => ({ ...state,
      processes: [{ pid: process.pid, stopped: false, identity: { started: 'old-process-start', group: 2147483647 } }] })))
    yield* recover
    expect(yield* queue.get('first')).toMatchObject({ state: 'interrupted' })
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true)
  }).pipe(Effect.provide(layer())))
})

it('retains recovery files when the execution database cannot be read', async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const { files, recover } = yield* setup
    const before = yield* fileEffect(() => files.read('first', 'owner'))
    const sql = yield* SqlClient.SqlClient
    // Simulate an unavailable ledger while the filesystem remains accessible.
    yield* sql`ALTER TABLE runs RENAME TO unavailable_runs`
    expect((yield* recover.pipe(Effect.exit))._tag).toBe('Failure')
    expect(yield* fileEffect(() => files.read('first', 'owner'))).toEqual(before)
  }).pipe(Effect.provide(layer())))
})
