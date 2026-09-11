import { Effect, ManagedRuntime } from 'effect'
import { expect, it, vi } from 'vitest'
import { routineSchedulerLayer } from './routine-scheduler'

it('sweeps immediately, recovers from failure and stops after scope disposal', async () => {
  let calls = 0
  const runtime = ManagedRuntime.make(routineSchedulerLayer(Effect.suspend(() => {
    calls++
    return calls === 1 ? Effect.fail('fixture failure') : Effect.void
  }), 10))
  await runtime.runPromise(Effect.void)
  await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2))
  await runtime.dispose()
  const stopped = calls
  await new Promise(resolve => setTimeout(resolve, 40))
  expect(calls).toBe(stopped)
})

it('does not overlap sweeps and awaits interruption cleanup on Quit', async () => {
  let calls = 0
  let finalized = false
  const runtime = ManagedRuntime.make(routineSchedulerLayer(Effect.sync(() => { calls++ }).pipe(
    Effect.andThen(Effect.never), Effect.ensuring(Effect.sync(() => { finalized = true }))
  ), 5))
  await runtime.runPromise(Effect.void)
  await vi.waitFor(() => expect(calls).toBe(1))
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(calls).toBe(1)
  await runtime.dispose()
  expect(finalized).toBe(true)
})
