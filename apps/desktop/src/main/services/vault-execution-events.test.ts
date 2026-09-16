import { NodeServices } from '@effect/platform-node'
import { ConfigProvider, Effect, Layer, ManagedRuntime } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ExecutionEventPayload } from '../../shared/execution-events'
import { ConfigService } from './config-service'
import { ExecutionEventLog } from './execution-event-log'
import { ExecutionQueue } from './execution-queue'
import { HarnessStore } from './harness-store'
import { HarnessEventStore } from './harness-event-store'
import { RoutineStore } from './routine-store'
import { VaultContext } from './vault-context'
import { vaultDatabaseLayer } from './vault-database'
import { VaultExecutionEvents } from './vault-execution-events'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'folio-vault-subscriber-')); await mkdir(join(root, 'a')); await mkdir(join(root, 'b')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const logLayer = () => ExecutionEventLog.layer.pipe(Layer.provide(ConfigService.layer), Layer.provide(NodeServices.layer),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ FOLIO_CONFIG_DIR: root }))))
const vaultLayer = (log: ExecutionEventLog['Service'], id = 'a') => VaultExecutionEvents.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(HarnessStore.layer, HarnessEventStore.layer, RoutineStore.layer, ExecutionQueue.layer)),
  Layer.provideMerge(vaultDatabaseLayer(join(root, id))),
  Layer.provide(Layer.succeed(ExecutionEventLog)(log)),
  Layer.provide(Layer.succeed(VaultContext)({ id, directory: join(root, id), vault: { id, name: id, path: join(root, id) } }))
)
const setup = Effect.gen(function* () {
  const store = yield* HarnessStore
  yield* store.createTask({ id: 'task', goal: 'notes', branch: 'task', worktree: '/worktrees/task', configuration: { agent: 'codex', skillIds: [], integrationIds: [] } })
  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE tasks SET worktree_state='ready' WHERE id='task'`
  yield* store.createSession({ id: 'session', taskId: 'task', agent: 'codex', adapterVersion: '1', purpose: 'task', syncOperationId: null })
  const queue = yield* ExecutionQueue
  yield* queue.submit({ id: 'run', taskId: 'task', sessionId: 'session', prompt: 'notes', purpose: 'execution', resumesRunId: null, source: 'manual' })
  yield* queue.claim('attempt')
})
const update = (sequence: number, text: string): ExecutionEventPayload => ({ _tag: 'update', update: {
  sessionId: 'session', runId: 'run', connectionId: 'connection', notification: { sessionId: 'acp',
    _meta: { 'folio/eventSequence': sequence },
    update: { sessionUpdate: 'agent_message_chunk', messageId: 'message', content: { type: 'text', text } }
  }
} })

it('rolls back messages with the cursor, retries projection without execution and resumes after subscriber downtime', async () => {
  const global = ManagedRuntime.make(logLayer())
  const log = await global.runPromise(ExecutionEventLog)
  let vault = ManagedRuntime.make(vaultLayer(log))
  const emit = (eventId: string, payload: ExecutionEventPayload, vaultId = 'a') => global.runPromise(log.append({
    eventId, vaultId, taskId: 'task', sessionId: 'session', runId: 'run', attemptId: 'attempt', payload
  }))
  try {
    await vault.runPromise(setup)
    await emit('bind', { _tag: 'session-bound', binding: { acpSessionId: 'acp', nativeSessionId: 'native' } })
    const reserved = await emit('reserve', { _tag: 'run-reserved', run: {
      id: 'run', taskId: 'task', sessionId: 'session', prompt: 'notes', purpose: 'execution', resumesRunId: null, baselineCommit: 'base'
    } })
    await vault.runPromise(Effect.gen(function* () {
      yield* (yield* VaultExecutionEvents).drain
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TRIGGER fail_projection BEFORE INSERT ON messages WHEN NEW.kind='message'
        BEGIN SELECT RAISE(ABORT, 'injected projection failure'); END`
    }))
    await emit('message-1', update(1, 'hello'))
    await vault.runPromise(Effect.gen(function* () {
      const subscriber = yield* VaultExecutionEvents
      expect(yield* subscriber.drain.pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
      expect(yield* subscriber.position).toBe(reserved.sequence)
      const sql = yield* SqlClient.SqlClient
      expect(yield* sql`SELECT id FROM messages`).toEqual([])
      yield* sql`DROP TRIGGER fail_projection`
      yield* subscriber.drain
      expect((yield* (yield* HarnessEventStore).messages('session'))[0]?.data.content).toEqual([{ type: 'text', text: 'hello' }])
    }))
    // A replay under another event ID still must not apply an ACP chunk twice.
    await emit('message-1-replayed', update(1, 'hello'))
    await vault.dispose()
    await emit('message-2', update(2, ' world'))
    await emit('other-vault', update(1, 'private'), 'b')
    vault = ManagedRuntime.make(vaultLayer(log))
    await vault.runPromise(Effect.gen(function* () {
      yield* (yield* VaultExecutionEvents).drain
      const messages = yield* (yield* HarnessEventStore).messages('session')
      expect(messages).toHaveLength(1)
      expect(messages[0]!.data.content).toEqual([{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }])
      expect(JSON.stringify(messages)).not.toContain('private')
      expect(yield* (yield* ExecutionQueue).get('run')).toMatchObject({ state: 'preparing', owner: 'attempt' })
      expect(yield* (yield* HarnessStore).runs('task')).toHaveLength(1)
    }))
    await emit('running', { _tag: 'run-running' })
    await emit('finished', { _tag: 'run-finished', outcome: 'succeeded', error: null })
    await vault.runPromise(Effect.gen(function* () {
      yield* (yield* VaultExecutionEvents).drain
      // Cancellation after the Run's success receipt cannot rewrite the known outcome.
      yield* (yield* ExecutionQueue).cancel('run')
    }))
    await emit('request-finished', { _tag: 'request-finished', outcome: 'cancelled', error: null })
    await vault.runPromise(Effect.gen(function* () {
      yield* (yield* VaultExecutionEvents).drain
      expect(yield* (yield* ExecutionQueue).get('run')).toMatchObject({ state: 'succeeded' })
    }))
  } finally { await vault.dispose(); await global.dispose() }
})
