import { Effect } from 'effect'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { RoutineStore } from './routine-store'
import { vaultDatabaseLayer } from './vault-database'
import { Layer } from 'effect'
import type { SaveRoutine } from '../../shared/routine'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'folio-routines-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const definition: SaveRoutine['definition'] = { name: 'Daily notes', prompt: 'Use the selected skills to summarize notes.',
  configuration: { agent: 'codex', skillIds: [], integrationIds: ['notes'] }, model: null, enabled: true }
/** A fresh database layer per call verifies on-disk snapshots across application restarts. */
function run<A>(effect: Effect.Effect<A, unknown, RoutineStore>) {
  return Effect.runPromise(effect.pipe(Effect.provide(RoutineStore.layer.pipe(Layer.provide(vaultDatabaseLayer(root))))))
}

it('preserves accepted configuration and task identity after edits, pauses and restart', async () => {
  const input = { id: randomUUID(), expectedRevision: null, definition }
  const trigger = { id: randomUUID(), routineId: input.id, expectedRevision: 1 }
  const accepted = await run(Effect.gen(function*() {
    const store = yield* RoutineStore
    yield* store.save(input)
    const first = yield* store.claim(trigger)
    yield* store.save({ ...input, expectedRevision: 1, definition: { ...definition, prompt: 'New prompt', enabled: false } })
    return first
  }))
  await run(Effect.gen(function*() {
    const store = yield* RoutineStore
    expect(yield* store.triggers(input.id)).toEqual([accepted])
    expect(yield* store.claim(trigger)).toEqual(accepted)
    expect(yield* store.forTask(accepted.taskId)).toEqual(accepted)
    expect(accepted.snapshot.definition.prompt).toBe(definition.prompt)
    expect(yield* store.claim({ ...trigger, id: randomUUID(), expectedRevision: 2 }).pipe(Effect.flip))
      .toMatchObject({ reason: 'invalid-state' })
    expect(yield* store.claim({ ...trigger, routineId: randomUUID() }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    expect(yield* store.claim({ ...trigger, expectedRevision: 2 }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
  }))
})

it('deduplicates retries and rejects stale editors while preserving newer definitions', async () => {
  await run(Effect.gen(function*() {
    const store = yield* RoutineStore
    const input = { id: randomUUID(), expectedRevision: null, definition }
    const saved = yield* store.save(input)
    expect(yield* store.save(input)).toEqual(saved)
    const edit = { ...input, expectedRevision: 1, definition: { ...definition, name: 'Edited' } }
    const updated = yield* store.save(edit)
    expect(updated.revision).toBe(2)
    expect(yield* store.save(edit)).toEqual(updated)
    expect(yield* store.save({ ...edit, definition }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    expect(yield* store.save(input).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    const trigger = { id: randomUUID(), routineId: input.id, expectedRevision: 2 }
    const results = yield* Effect.all([store.claim(trigger), store.claim(trigger)], { concurrency: 'unbounded' })
    expect(results[0]).toEqual(results[1])
    const next = yield* store.claim({ ...trigger, id: randomUUID() })
    expect(next.taskId).not.toBe(results[0]!.taskId)
    expect(yield* store.list).toEqual([updated])
  }))
})

it('requires a matching Agent/model choice and rejects credentials in definition input', async () => {
  await run(Effect.gen(function*() {
    const store = yield* RoutineStore
    const input = { id: randomUUID(), expectedRevision: null, definition }
    expect(yield* store.save({ ...input, definition: { ...definition,
      configuration: { ...definition.configuration, agent: 'pi' } } }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    const invalid = { ...input, definition: { ...definition, apiKey: 'private-sentinel' } }
    const error = yield* store.save(invalid).pipe(Effect.flip)
    expect(JSON.stringify(error)).not.toContain('private-sentinel')
    expect(yield* store.list).toEqual([])
  }))
})
