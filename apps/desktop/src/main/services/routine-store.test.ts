import { Effect, Layer } from 'effect'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RoutineStore } from './routine-store'
import { vaultDatabaseLayer } from './vault-database'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'folio-routine-store-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const layer = () => RoutineStore.layer.pipe(Layer.provideMerge(vaultDatabaseLayer(root)))
const routineId = '11111111-1111-4111-8111-111111111111'

const setup = Effect.gen(function* () {
  const store = yield* RoutineStore
  yield* store.save({ id: routineId, expectedRevision: null, name: 'Inbox', prompt: 'Process today', agent: 'codex', model: null, skillIds: [], integrationIds: ['lark'], resourceIds: ['lark/im'], intervalMinutes: 30, timeZone: 'UTC', enabled: true })
})

describe('RoutineStore execution coalescing', () => {
  it('updates one same-day execution and upgrades it on the next day close', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      yield* setup
      const store = yield* RoutineStore
      expect((yield* store.get(routineId)).resourceIds).toEqual(['lark/im'])
      const first = yield* store.schedule(routineId, Date.parse('2026-09-11T10:00:00.000Z'))
      const second = yield* store.schedule(routineId, Date.parse('2026-09-11T10:30:00.000Z'))
      expect(second.id).toBe(first.id)
      expect(second.triggerCount).toBe(2)
      expect(second.routineDate).toBe('2026-09-11')
      const end = yield* store.schedule(routineId, Date.parse('2026-09-12T00:05:00.000Z'))
      expect(end.id).toBe(first.id)
      expect(end.isEnd).toBe(true)
      expect(end.routineDate).toBe('2026-09-11')
      expect(end.triggerTime).toBe(Date.parse('2026-09-11T23:59:59.999Z'))
      expect(yield* store.executions(routineId)).toHaveLength(1)
    }).pipe(Effect.provide(layer())))
  })

  it('does not create a catch-up queue while an old execution remains unhandled', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      yield* setup
      const store = yield* RoutineStore
      const first = yield* store.schedule(routineId, Date.parse('2026-09-11T10:00:00.000Z'))
      const resumed = yield* store.schedule(routineId, Date.parse('2026-09-14T10:00:00.000Z'))
      expect(resumed.id).toBe(first.id)
      expect(resumed.triggerCount).toBe(2)
      expect(yield* store.executions(routineId)).toHaveLength(1)
    }).pipe(Effect.provide(layer())))
  })
})
