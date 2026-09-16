import { NodeServices } from '@effect/platform-node'
import { ConfigProvider, Effect, Layer } from 'effect'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ExecutionEventInput } from '../../shared/execution-events'
import { ConfigService } from './config-service'
import { ExecutionEventLog } from './execution-event-log'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'folio-execution-events-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const layer = () => ExecutionEventLog.layer.pipe(
  Layer.provide(ConfigService.layer), Layer.provide(NodeServices.layer),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ FOLIO_CONFIG_DIR: root })))
)
const event = (eventId: string, vaultId = 'a'): ExecutionEventInput => ({
  eventId, vaultId, taskId: 'task', sessionId: 'session', runId: 'run', attemptId: 'worker',
  payload: { _tag: 'request-finished', outcome: 'failed', error: 'Runtime unavailable' }
})

it('replays committed events without a subscriber, isolates Vaults and deduplicates exact event identity', async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const log = yield* ExecutionEventLog
    const saved = yield* log.append(event('first'))
    expect(yield* log.append(event('first'))).toEqual(saved)
    expect(yield* log.append({ ...event('first'), vaultId: 'b' }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    yield* log.append(event('other-vault', 'b'))
    yield* log.append(event('second'))
  }).pipe(Effect.provide(layer())))
  // A fresh connection has no in-memory notifications or subscribers from the original process.
  await Effect.runPromise(Effect.gen(function* () {
    const log = yield* ExecutionEventLog
    const events = yield* log.after('a', 0)
    expect(events.map(value => value.eventId)).toEqual(['first', 'second'])
    expect(events[1]!.sequence).toBeGreaterThan(events[0]!.sequence + 1)
    expect(yield* log.after('a', events[0]!.sequence)).toEqual([events[1]])
    expect((yield* log.after('b', 0)).map(value => value.eventId)).toEqual(['other-vault'])
  }).pipe(Effect.provide(layer())))
})

it('preserves ACP extension metadata needed for faithful replay', async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const log = yield* ExecutionEventLog
    const saved = yield* log.append({ ...event('update'), payload: { _tag: 'update', update: {
      sessionId: 'session', runId: 'run', connectionId: 'connection', notification: {
        sessionId: 'acp', update: { sessionUpdate: 'state', state: 'idle', _meta: { 'folio/executionInterrupted': true } },
        _meta: { 'folio/eventSequence': 1 }
      }
    } } })
    expect((yield* log.after('a', 0))[0]).toEqual(saved)
    expect(saved.payload).toMatchObject({ update: { notification: { update: { _meta: { 'folio/executionInterrupted': true } } } } })
  }).pipe(Effect.provide(layer())))
})

it('retains process occupancy independently of an unavailable Vault projection', async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const log = yield* ExecutionEventLog
    yield* log.append({ ...event('started'), payload: { _tag: 'process-started', pid: 123 } })
    yield* log.append({ ...event('other-started', 'b'), payload: { _tag: 'process-started', pid: 456 } })
    expect(yield* log.unstoppedProcesses('a')).toEqual([123])
    yield* log.append({ ...event('stopped'), payload: { _tag: 'process-stopped' } })
    expect(yield* log.unstoppedProcesses('a')).toEqual([])
    expect(yield* log.unstoppedProcesses('b')).toEqual([456])
  }).pipe(Effect.provide(layer())))
})
