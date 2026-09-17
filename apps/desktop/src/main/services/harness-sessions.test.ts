import { AgentWorkerPool } from './agent-worker-pool'
import { protocolTestSink } from './testing/execution-event-sink'
import { NodeServices } from '@effect/platform-node'
import { Effect, Fiber, Layer, ManagedRuntime } from 'effect'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HarnessSessions } from './harness-sessions'
import { HarnessStore } from './harness-store'
import { HarnessEventStore } from './harness-event-store'
import { TaskWorktrees } from './task-worktrees'
import { initializeVaultWorkspace } from './vault-workspace'
import { vaultDatabaseLayer } from './vault-database'

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'folio-session-manager-')))
  await mkdir(join(root, 'wiki'))
  let fixture = await readFile(resolve('../../packages/agent/tests/fixtures/codex-app-server.mjs'), 'utf8')
  fixture = fixture.replace('id: "native-thread"', 'id: process.cwd()')
  fixture = fixture.replace('readFileSync, writeFileSync', 'readFileSync, writeFileSync, existsSync')
  fixture = fixture.replace('if (method === "initialize") return send({ id, result: { userAgent: "fixture" } });',
    'if (method === "initialize") { writeFileSync("initializing", String(process.pid)); const timer = setInterval(() => { if (existsSync("block-startup")) return; clearInterval(timer); send({ id, result: { userAgent: "fixture" } }); }, 10); timer.unref(); return; }')
  await writeFile(join(root, 'codex'), `#!/usr/bin/env node\n${fixture}`, { mode: 0o700 })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

/** Uses the production Worker and SDK layers and real Git/SQLite; only the native protocol endpoint is a fixture. */
function runtime(entrypoint = resolve('out/main/agent-worker.js')) {
  return ManagedRuntime.make(HarnessSessions.layer({ entrypoint,
    configDirectory: root, agentDirectory: join(root, 'agent'), sessionStorageDirectory: join(root, 'vault-history'), codexExecutable: join(root, 'codex')
  }).pipe(
    Layer.provide(protocolTestSink),
    Layer.provide(AgentWorkerPool.layer), Layer.provideMerge(TaskWorktrees.layer(root)),
    Layer.provideMerge(Layer.merge(HarnessStore.layer, HarnessEventStore.layer)),
    Layer.provideMerge(vaultDatabaseLayer(root)), Layer.provideMerge(NodeServices.layer)
  ))
}
/** Prepares persisted identities without starting the Agent or sending a Prompt. */
const setup = Effect.gen(function*() {
  yield* initializeVaultWorkspace(root, join(root, 'wiki'))
  const worktrees = yield* TaskWorktrees
  const store = yield* HarnessStore
  for (const id of ['a', 'b']) {
    yield* worktrees.create({ id, goal: 'notes', configuration: { agent: 'codex', skillIds: [], integrationIds: [] } })
    yield* store.createSession({ id, taskId: id, agent: 'codex', adapterVersion: '1', purpose: 'task', syncOperationId: null })
  }
  yield* store.createSession({ id: 'alternate', taskId: 'a', agent: 'codex', adapterVersion: '1', purpose: 'task', syncOperationId: null })
})

describe.skipIf(process.platform === 'win32')('application-owned Harness sessions', () => {
  it('joins concurrent opens, survives request scopes, and closes before allowing a persisted Session to reopen', async () => {
    const app = runtime()
    let pid = 0
    try {
      await app.runPromise(setup)
      const sessions = await app.runPromise(HarnessSessions)
      expect(await app.runPromise(sessions.hasLiveTask('a'))).toBe(false)
      const [a, same, b] = await app.runPromise(Effect.all([
        sessions.open('a', 'a'), sessions.open('a', 'a'), sessions.open('b', 'b')
      ], { concurrency: 'unbounded' }).pipe(Effect.scoped))
      expect(await app.runPromise(sessions.hasLiveTask('a'))).toBe(true)
      pid = b.pid
      expect(a).toBe(same)
      expect(a.pid).not.toBe(b.pid)
      expect(() => process.kill(a.pid, 0)).not.toThrow()
      expect(await app.runPromise(sessions.open('b', 'a').pipe(Effect.flip))).toMatchObject({ reason: 'not-found' })
      expect(await app.runPromise(sessions.open('a', 'alternate').pipe(Effect.flip))).toMatchObject({ reason: 'task-busy' })
      const store = await app.runPromise(HarnessStore)
      const before = await app.runPromise(store.sessions('a'))
      await app.runPromise(Effect.all([sessions.close('a', 'a'), sessions.close('a', 'a')], { concurrency: 'unbounded' }))
      expect(await app.runPromise(sessions.hasLiveTask('a'))).toBe(false)
      expect(() => process.kill(a.pid, 0)).toThrow()
      const resumed = await app.runPromise(sessions.open('a', 'a'))
      expect(resumed.pid).not.toBe(a.pid)
      expect(await app.runPromise(store.sessions('a'))).toEqual(before)
      expect(await app.runPromise(store.runs('a'))).toEqual([])
      await app.runPromise(sessions.close('a', 'a'))
    } finally { await app.dispose() }
    expect(() => process.kill(pid, 0)).toThrow()
  }, 15000)

  it('keeps startup alive after its requesting fiber is interrupted and reaps the native process on Quit', async () => {
    const app = runtime()
    let nativePid = 0
    let acpPid = 0
    try {
      await app.runPromise(setup)
      const sessions = await app.runPromise(HarnessSessions)
      await writeFile(join(root, 'worktrees/a/block-startup'), '')
      const request = app.runFork(sessions.open('a', 'a'))
      await vi.waitFor(async () => { nativePid = Number(await readFile(join(root, 'worktrees/a/initializing'), 'utf8')); expect(nativePid).toBeGreaterThan(0) }, { timeout: 5000 })
      await app.runPromise(Fiber.interrupt(request))
      expect(() => process.kill(nativePid, 0)).not.toThrow()
      await rm(join(root, 'worktrees/a/block-startup'))
      acpPid = (await app.runPromise(sessions.open('a', 'a'))).pid
    } finally { await app.dispose() }
    expect(() => process.kill(acpPid, 0)).toThrow()
    expect(() => process.kill(nativePid, 0)).toThrow()
  }, 15000)

  it('closes during startup, resolves its waiter and retains the saved Session for explicit retry', async () => {
    const app = runtime()
    try {
      await app.runPromise(setup)
      const sessions = await app.runPromise(HarnessSessions)
      await writeFile(join(root, 'worktrees/a/block-startup'), '')
      const request = app.runFork(sessions.open('a', 'a'))
      let nativePid = 0
      await vi.waitFor(async () => { nativePid = Number(await readFile(join(root, 'worktrees/a/initializing'), 'utf8')); expect(nativePid).toBeGreaterThan(0) }, { timeout: 5000 })
      await app.runPromise(sessions.close('a', 'a'))
      expect(() => process.kill(nativePid, 0)).toThrow()
      expect((await app.runPromise(Fiber.await(request)))._tag).toBe('Failure')
      await rm(join(root, 'worktrees/a/block-startup'))
      const reopened = await app.runPromise(sessions.open('a', 'a'))
      expect(() => process.kill(reopened.pid, 0)).not.toThrow()
      const store = await app.runPromise(HarnessStore)
      expect((await app.runPromise(store.sessions('a'))).map(session => session.id)).toEqual(['a', 'alternate'])
      expect(await app.runPromise(store.runs('a'))).toEqual([])
    } finally { await app.dispose() }
  }, 15000)

  it('retains failed startup until explicit close and refuses to restore a Session with an unresolved Run', async () => {
    const app = runtime(join(root, 'missing.mjs'))
    try {
      await app.runPromise(setup)
      const sessions = await app.runPromise(HarnessSessions)
      const failed = await app.runPromise(sessions.open('a', 'a').pipe(Effect.flip))
      expect(await app.runPromise(sessions.open('a', 'a').pipe(Effect.flip))).toBe(failed)
      await app.runPromise(sessions.close('a', 'a'))
      await app.runPromise(Effect.gen(function*() {
        const store = yield* HarnessStore
        yield* store.bindSession('a', { acpSessionId: 'fixture', nativeSessionId: null })
        yield* store.reserveRun({ id: 'uncertain', taskId: 'a', sessionId: 'a', prompt: 'may have run', purpose: 'execution', resumesRunId: null,
          baselineCommit: (yield* store.task('a')).worktreeBase! })
        expect(yield* sessions.open('a', 'a').pipe(Effect.flip)).toMatchObject({ reason: 'task-busy' })
        expect(yield* store.runs('a')).toMatchObject([{ id: 'uncertain', state: 'preparing', endedAt: null }])
      }))
    } finally { await app.dispose() }
  }, 15000)
})
