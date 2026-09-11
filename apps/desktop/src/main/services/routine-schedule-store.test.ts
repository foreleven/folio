import { Effect, Layer } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { nextDailyOccurrence } from '../../shared/routine-schedule'
import { RoutineStore } from './routine-store'
import { RoutineScheduleStore } from './routine-schedule-store'
import { vaultDatabaseLayer } from './vault-database'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'folio-daily-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const layer = () => RoutineScheduleStore.layer.pipe(Layer.provideMerge(RoutineStore.layer), Layer.provideMerge(vaultDatabaseLayer(root)))
const definition = { name: 'Daily', prompt: 'Fixture', enabled: true, model: null,
  configuration: { agent: 'codex' as const, skillIds: [], integrationIds: [] } }

it('calculates strict civil-day times across midnight, leap day, DST gaps and repeated hours', () => {
  const next = (time: string, zone: string, after: string) => new Date(nextDailyOccurrence(time, zone, Date.parse(after))).toISOString()
  expect(next('09:00', 'Asia/Shanghai', '2026-09-10T00:59:59Z')).toBe('2026-09-10T01:00:00.000Z')
  expect(next('09:00', 'Asia/Shanghai', '2026-09-10T01:00:00Z')).toBe('2026-09-11T01:00:00.000Z')
  expect(next('00:00', 'UTC', '2024-02-28T23:59:59Z')).toBe('2024-02-29T00:00:00.000Z')
  expect(next('02:30', 'America/New_York', '2026-03-08T05:00:00Z')).toBe('2026-03-08T07:30:00.000Z')
  expect(next('01:30', 'America/New_York', '2026-11-01T04:00:00Z')).toBe('2026-11-01T05:30:00.000Z')
  expect(next('01:30', 'America/New_York', '2026-11-01T05:30:00Z')).toBe('2026-11-02T06:30:00.000Z')
  expect(() => next('24:00', 'UTC', '2026-01-01Z')).toThrow()
  expect(() => next('09:00', 'Invalid/Zone', '2026-01-01Z')).toThrow()
})

it('persists schedule/timezone, protects edits and atomically collects missed dates once across restart', async () => {
  const id = randomUUID()
  await Effect.runPromise(Effect.gen(function*() {
    const schedules = yield* RoutineScheduleStore
    const routines = yield* RoutineStore
    const sql = yield* SqlClient.SqlClient
    yield* routines.save({ id, expectedRevision: null, definition })
    expect(yield* schedules.save({ routineId: id, time: '09:00', expectedRevision: null }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    yield* schedules.setTimeZone('Asia/Shanghai', null)
    const input = { routineId: id, time: '09:00', expectedRevision: null }
    const saved = yield* schedules.save(input)
    expect(yield* schedules.save(input)).toEqual(saved)
    expect(yield* schedules.setTimeZone('UTC', null).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    // Rewind the durable cursor to simulate an app closed across three scheduled dates.
    const today = nextDailyOccurrence('09:00', 'Asia/Shanghai', Date.now()) - 86400000
    yield* sql`UPDATE routine_schedules SET next_at=${today - 2 * 86400000} WHERE routine_id=${id}`
    yield* schedules.collectDue
    expect((yield* routines.wakeups(id)).map(w => w.triggeredAt)).toEqual([today - 2 * 86400000, today - 86400000, today])
    yield* schedules.collectDue
    expect(yield* routines.wakeups(id)).toHaveLength(3)
    expect((yield* schedules.settings).schedules[0]?.nextAt).toBe(today + 86400000)
  }).pipe(Effect.provide(layer())))
  await Effect.runPromise(Effect.gen(function*() {
    const schedules = yield* RoutineScheduleStore
    const routines = yield* RoutineStore
    yield* schedules.collectDue
    expect(yield* routines.wakeups(id)).toHaveLength(3)
    const batch = yield* routines.claimPending(id)
    expect(new Set((yield* routines.wakeups(id)).map(w => w.triggerId))).toEqual(new Set([batch!.id]))
    yield* schedules.setTimeZone('UTC', 'Asia/Shanghai')
    expect((yield* schedules.settings).schedules[0]?.revision).toBe(2)
    expect(yield* schedules.save({ routineId: id, time: '10:00', expectedRevision: 1 }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    yield* schedules.remove(id, 2)
    expect((yield* schedules.settings).schedules).toEqual([])
    expect(yield* routines.wakeups(id)).toHaveLength(3)
  }).pipe(Effect.provide(layer())))
})

it('skips paused dates, bounds catch-up pages, and leaves all missed dates in one pending batch', async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const schedules = yield* RoutineScheduleStore
    const routines = yield* RoutineStore
    const sql = yield* SqlClient.SqlClient
    const id = randomUUID()
    yield* routines.save({ id, expectedRevision: null, definition })
    yield* schedules.setTimeZone('UTC', null)
    yield* schedules.save({ routineId: id, time: '00:00', expectedRevision: null })
    const today = nextDailyOccurrence('00:00', 'UTC', Date.now()) - 86400000
    yield* sql`UPDATE routine_schedules SET next_at=${today - 400 * 86400000} WHERE routine_id=${id}`
    yield* schedules.collectDue
    expect(yield* routines.wakeups(id)).toHaveLength(366)
    yield* schedules.collectDue
    expect(yield* routines.wakeups(id)).toHaveLength(401)
    yield* schedules.collectDue
    expect(yield* routines.wakeups(id)).toHaveLength(401)
    const batch = yield* routines.claimPending(id)
    expect(new Set((yield* routines.wakeups(id)).map(w => w.triggerId))).toEqual(new Set([batch!.id]))
    yield* routines.save({ id, expectedRevision: 1, definition: { ...definition, enabled: false } })
    yield* sql`UPDATE routine_schedules SET next_at=${today - 86400000} WHERE routine_id=${id}`
    yield* schedules.collectDue
    expect(yield* routines.wakeups(id)).toHaveLength(401)
    expect((yield* schedules.settings).schedules[0]?.nextAt).toBe(today + 86400000)
  }).pipe(Effect.provide(layer())))
})

it('re-enables after offline pause without backfilling paused dates or dropping accepted wakeups', async () => {
  const id = randomUUID()
  await Effect.runPromise(Effect.gen(function*() {
    const schedules = yield* RoutineScheduleStore
    const routines = yield* RoutineStore
    const sql = yield* SqlClient.SqlClient
    yield* routines.save({ id, expectedRevision: null, definition })
    yield* schedules.setTimeZone('Asia/Shanghai', null)
    yield* schedules.save({ routineId: id, time: '09:00', expectedRevision: null })
    yield* routines.enqueue({ id: randomUUID(), routineId: id, triggeredAt: 1 })
    yield* routines.save({ id, expectedRevision: 1, definition: { ...definition, enabled: false } })
    yield* sql`UPDATE routine_schedules SET next_at=1 WHERE routine_id=${id}`
  }).pipe(Effect.provide(layer())))
  await Effect.runPromise(Effect.gen(function*() {
    const routines = yield* RoutineStore
    const schedules = yield* RoutineScheduleStore
    const sql = yield* SqlClient.SqlClient
    // A stale enable does not advance the cursor or overwrite the paused definition.
    expect(yield* routines.save({ id, expectedRevision: 1, definition }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    expect((yield* schedules.settings).schedules[0]?.nextAt).toBe(1)
    const enable = { id, expectedRevision: 2, definition }
    // Failure after updating the definition must roll back both enabled state and cursor.
    yield* sql`CREATE TRIGGER reject_cursor BEFORE UPDATE OF next_at ON routine_schedules
      BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END`
    expect(yield* routines.save(enable).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
    expect(yield* routines.list).toMatchObject([{ revision: 2, definition: { enabled: false } }])
    expect((yield* schedules.settings).schedules[0]?.nextAt).toBe(1)
    yield* sql`DROP TRIGGER reject_cursor`
    yield* routines.save(enable)
    const resumed = (yield* schedules.settings).schedules[0]!
    expect(resumed.nextAt).toBeGreaterThan(Date.now())
    yield* schedules.collectDue
    expect(yield* routines.wakeups(id)).toHaveLength(1)
    // Lost-reply retries must not move an already resumed cursor a second time.
    yield* sql`UPDATE routine_schedules SET next_at=${resumed.nextAt + 86400000} WHERE routine_id=${id}`
    yield* routines.save(enable)
    expect((yield* schedules.settings).schedules[0]?.nextAt).toBe(resumed.nextAt + 86400000)
    expect((yield* routines.claimPending(id))?.snapshot.revision).toBe(3)
  }).pipe(Effect.provide(layer())))
})
