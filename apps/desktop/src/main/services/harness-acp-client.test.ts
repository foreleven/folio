import { SessionUpdate } from '@agentclientprotocol/sdk/experimental/v2'
import { NodeServices } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HarnessStore } from './harness-store'
import { HarnessEventStore } from './harness-event-store'
import { openHarnessSession } from './harness-session'
import { vaultDatabaseLayer } from './vault-database'
import { TaskWorktrees } from './task-worktrees'
import { initializeVaultWorkspace } from './vault-workspace'

let root: string
let selected: string
let baseline: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'folio-harness-client-'))
  selected = join(root, 'user-wiki')
  await mkdir(selected)
  const fixture = await readFile(resolve('../../packages/agent/tests/fixtures/codex-app-server.mjs'), 'utf8')
  await writeFile(join(root, 'codex'), `#!/usr/bin/env node\n${fixture}`, { mode: 0o700 })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
/** Each connection uses the built production CLI and a real native subprocess running the protocol fixture. */
function sessionOptions() {
  return { taskId: 'task', sessionId: 'folio', nodeExecutable: process.execPath,
    entrypoint: resolve('../../packages/agent/dist/cli.js'), configDirectory: root,
    agentDirectory: join(root, 'agent'), sessionStorageDirectory: join(root, 'vault-history'), codexExecutable: join(root, 'codex') }
}
/** Ledger/services persist across separate process and connection scopes. */
function layer() {
  return Layer.mergeAll(TaskWorktrees.layer(root).pipe(Layer.provideMerge(HarnessStore.layer)), HarnessEventStore.layer).pipe(Layer.provideMerge(vaultDatabaseLayer(root)), Layer.provideMerge(NodeServices.layer))
}
const setup = Effect.gen(function*() {
  const store = yield* HarnessStore
  yield* initializeVaultWorkspace(root, selected)
  const worktrees = yield* TaskWorktrees
  baseline = (yield* worktrees.create({ id: 'task', goal: 'notes', configuration: { agent: 'codex', skillIds: [], integrationIds: [] } })).baselineCommit
  yield* store.createSession({ id: 'folio', taskId: 'task', agent: 'codex', adapterVersion: '1', purpose: 'task', syncOperationId: null })
})
const input = (id: string, prompt = 'early-completion') => ({ id, prompt, taskId: 'task', sessionId: 'folio', purpose: 'execution' as const, resumesRunId: null, baselineCommit: baseline })

describe.skipIf(process.platform === 'win32')('harness ACP client over production stdio', () => {
  it('persists malformed ACP output metadata before the Session handshake completes', async () => {
    const entrypoint = join(root, 'malformed-agent.cjs')
    await writeFile(entrypoint, `
      const readline = require('node:readline');
      process.stdout.write(Buffer.from([0xff, 0xfe, 0x0a]));
      const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
      readline.createInterface({ input: process.stdin }).on('line', line => {
        const message = JSON.parse(line);
        if (message.method === 'initialize') return send({ jsonrpc: '2.0', id: message.id,
          result: { protocolVersion: 2, info: { name: 'fixture', version: '1' }, capabilities: {} } });
        if (message.method === 'session/new') return send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'native' } });
        if (message.method === 'session/close') return send({ jsonrpc: '2.0', id: message.id, result: {} });
      });
      setInterval(() => {}, 1000);
    `)
    await Effect.runPromise(Effect.gen(function*() {
      yield* setup
      const events = yield* HarnessEventStore
      const session = yield* openHarnessSession({ ...sessionOptions(), entrypoint })
      expect(yield* events.diagnostics('folio')).toMatchObject([{
        sessionId: 'folio', connectionId: session.connectionId, direction: 'inbound',
        reason: 'invalid-utf8', byteLength: 2
      }])
      yield* Effect.promise(() => session.close())
    }).pipe(Effect.scoped, Effect.provide(layer())))
  })

  it('interrupts a stalled audit and awaits its finalizer before Session cleanup finishes', async () => {
    await Effect.runPromise(Effect.gen(function*() {
      yield* setup
      const events = yield* HarnessEventStore
      let entered = false
      let finalized = false
      const session = yield* openHarnessSession({ ...sessionOptions(), requestTimeoutMs: 3000 }).pipe(
        Effect.provideService(HarnessEventStore, { ...events, appendProtocol: frame =>
          frame.direction === 'outbound' && frame.associations.some(item => item.method === 'session/prompt')
            ? Effect.sync(() => { entered = true }).pipe(Effect.andThen(Effect.never),
              Effect.ensuring(Effect.sleep(50).pipe(Effect.andThen(Effect.sync(() => { finalized = true })))))
            : events.appendProtocol(frame)
        })
      )
      const pending = session.prompt(input('stalled-audit')).then(value => ({ value }), error => ({ error }))
      yield* Effect.promise(() => vi.waitFor(() => expect(entered).toBe(true)))
      yield* Effect.promise(() => session.close())
      expect(finalized).toBe(true)
      expect(yield* Effect.promise(() => pending)).toMatchObject({ error: {} })
      expect(() => process.kill(session.pid, 0)).toThrow()
      expect((yield* events.protocol('folio')).some(frame => frame.associations.some(item => item.method === 'session/prompt'))).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(layer())))
  }, 15000)

  it('bounds shutdown even when an update consumer never returns', async () => {
    await Effect.runPromise(Effect.gen(function*() {
      yield* setup
      let delivered!: () => void
      const receiving = new Promise<void>(resolve => { delivered = resolve })
      const session = yield* openHarnessSession({ ...sessionOptions(), requestTimeoutMs: 3000, onUpdate: async notification => {
        if (SessionUpdate.isAgentMessageChunk(notification.update)) {
          delivered()
          await new Promise<void>(() => {})
        }
      } })
      const pending = session.prompt(input('slow-consumer')).then(value => ({ value }), error => ({ error }))
      yield* Effect.promise(() => receiving)
      const store = yield* HarnessStore
      yield* Effect.promise(() => vi.waitFor(async () => {
        expect(await Effect.runPromise(store.runs('task'))).toMatchObject([{ state: 'running' }])
      }))
      yield* Effect.promise(() => session.close())
      expect(() => process.kill(session.pid, 0)).toThrow()
      expect(yield* Effect.promise(() => pending)).toMatchObject({ error: { reason: 'timeout' } })
    }).pipe(Effect.scoped, Effect.provide(layer())))
  }, 15000)

  it('persists before delivery, runs multiple turns, and restores without resending prompts or duplicating messages', async () => {
    await Effect.runPromise(Effect.gen(function*() {
      yield* setup
      const store = yield* HarnessStore
      const events = yield* HarnessEventStore
      let delivered = 0
      const session = yield* openHarnessSession({ ...sessionOptions(), onUpdate: async notification => {
        delivered++
        if (SessionUpdate.isAgentMessage(notification.update)) {
          const messageId = notification.update.messageId
          const rows = await Effect.runPromise(events.messages('folio'))
          expect(rows.some(row => row.id === messageId)).toBe(true)
        }
      } })
      for (const id of ['first', 'second']) {
        const idle = yield* Effect.promise(() => session.prompt(input(id)))
        expect(idle.update).toMatchObject({ state: 'idle', stopReason: 'end_turn' })
        expect((yield* store.runs('task')).find(run => run.id === id)).toMatchObject({ state: 'running', syncState: 'pending' })
        // The future coordinator performs native-process/file checks before this transition.
        yield* store.finishRun(id, 'succeeded')
      }
      expect(delivered).toBeGreaterThan(0)
      expect((yield* events.messages('folio')).filter(row => row.data.role === 'assistant')).toHaveLength(2)
      yield* Effect.promise(() => session.close())
      expect(() => process.kill(session.pid, 0)).toThrow()
      const wire = yield* events.protocol('folio')
      for (const method of ['initialize', 'session/new', 'session/prompt', 'session/close']) {
        expect(wire.some(frame => frame.direction === 'outbound' && frame.associations.some(item => item.kind === 'request' && item.method === method))).toBe(true)
        expect(wire.some(frame => frame.direction === 'inbound' && frame.associations.some(item => item.kind === 'response' && item.method === method))).toBe(true)
      }
      expect(wire.flatMap(frame => frame.associations).filter(item => item.kind === 'response' && item.method === 'session/prompt').map(item => item.runId)).toEqual(['first', 'second'])
    }).pipe(Effect.scoped, Effect.provide(layer())))
    await Effect.runPromise(Effect.gen(function*() {
      const events = yield* HarnessEventStore
      const store = yield* HarnessStore
      const before = yield* events.messages('folio')
      let liveUpdates = 0
      yield* openHarnessSession({ ...sessionOptions(), onUpdate: async () => { liveUpdates++ } })
      expect(yield* events.messages('folio')).toEqual(before)
      expect(liveUpdates).toBe(0)
      expect(yield* store.runs('task')).toHaveLength(2)
      expect(yield* store.sessions('task')).toMatchObject([{ id: 'folio', nativeSessionId: 'native-thread' }])
      expect((yield* events.protocol('folio')).some(frame => frame.associations.some(item => item.kind === 'response' && item.method === 'session/resume' && item.runId === null))).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(layer())))
  }, 15000)

  it.each(['cancel', 'close'])('keeps the Task reserved and persists cancellation when invoking %s', async action => {
    await Effect.runPromise(Effect.gen(function*() {
      yield* setup
      const store = yield* HarnessStore
      const session = yield* openHarnessSession({ ...sessionOptions() })
      const pending = session.prompt(input('running', 'running'))
      const observed = pending.then(value => ({ value }), error => ({ error }))
      yield* Effect.promise(() => vi.waitFor(async () => {
        expect(await Effect.runPromise(store.runs('task'))).toMatchObject([{ state: 'running' }])
      }))
      yield* Effect.promise(() => expect(session.prompt(input('overlap'))).rejects.toMatchObject({ reason: 'busy' }))
      yield* Effect.promise(() => {
        if (action === 'cancel') return session.cancel()
        const closing = session.close()
        expect(session.close()).toBe(closing)
        return closing.then(() => { expect(() => process.kill(session.pid, 0)).toThrow() })
      })
      const result = yield* Effect.promise(() => observed)
      expect(result).toMatchObject({ value: { update: { state: 'idle', stopReason: 'cancelled' } } })
      expect(yield* store.runs('task')).toMatchObject([{ state: 'running' }])
      const events = yield* HarnessEventStore
      expect((yield* events.protocol('folio')).some(frame => frame.direction === 'outbound' && frame.associations.some(item => item.kind === 'notification' && item.method === 'session/cancel' && item.runId === 'running'))).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(layer())))
  }, 15000)

  it('closes on projection failure and preserves the uncertain Run without claiming success', async () => {
    await Effect.runPromise(Effect.gen(function*() {
      yield* setup
      const sql = yield* SqlClient.SqlClient
      const store = yield* HarnessStore
      const session = yield* openHarnessSession({ ...sessionOptions() })
      yield* sql`CREATE TRIGGER fail_projection BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`
      yield* Effect.promise(() => expect(session.prompt(input('uncertain'))).rejects.toMatchObject({ reason: 'storage' }))
      const rows = yield* store.runs('task')
      expect(rows).toHaveLength(1)
      expect(rows[0]?.endedAt).toBeNull()
      expect(['preparing', 'running']).toContain(rows[0]?.state)
      yield* Effect.promise(() => expect(session.prompt(input('retry'))).rejects.toMatchObject({ reason: 'storage' }))
    }).pipe(Effect.scoped, Effect.provide(layer())))
  }, 15000)
})
