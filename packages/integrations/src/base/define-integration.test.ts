import { NodeServices } from '@effect/platform-node'
import { Deferred, Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { defineIntegration, IntegrationError, readyState } from './index.ts'
import type { IntegrationContext, IntegrationEffect } from './index.ts'

/** Runs base effects with ordinary host services; no provider SDK or real credentials are involved. */
function run<A, E>(effect: IntegrationEffect<A, E>, signal?: AbortSignal) {
  return Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)), { signal })
}

/** A second, deliberately non-Lark provider demonstrates the reusable lifecycle contract. */
function provider(id = 'notes') {
  let phase = 'setup_required'
  const completion = Effect.runSync(Deferred.make<void>())
  const writes: { state: string; data: unknown }[] = []
  const registered: string[] = []
  const controls = { hold: false, fail: false, failWrite: false, calls: 0, payload: undefined as unknown,
    tracked: undefined as IntegrationContext | undefined }
  const context: IntegrationContext = {
    directory: `/tmp/folio-base-test/${id}`,
    writeState: (state, data) => Effect.suspend(() => controls.failWrite
      ? Effect.fail(new IntegrationError({ message: 'State unavailable' }))
      : Effect.sync(() => { writes.push({ state, data }) })),
    registerResource: (resource) => Effect.sync(() => { registered.push(resource.id) })
  }
  const resource = { id: 'pages', name: 'Pages', onIngest: () => Effect.void }
  const integration = defineIntegration({
    id, name: 'Notes', description: 'Personal notes', homepage: 'https://notes.example',
    logo: 'data:image/svg+xml,%3Csvg%2F%3E', resources: [resource],
    actions: [{ id: 'connect', label: 'Connect account' }],
    check: () => Effect.succeed({ state: phase, actionIds: phase === 'account_required' ? ['connect'] : [] }),
    install: (ctx) => Effect.gen(function*() {
      yield* ctx.writeState('preparing', { provider: id })
      yield* ctx.registerResource(resource)
      phase = 'account_required'
    }),
    onActionCallback: (ctx, _actionId, payload) => Effect.gen(function*() {
      controls.calls++
      controls.payload = payload
      controls.tracked = ctx
      yield* ctx.writeState('waiting_for_account', { arbitrary: ['provider data', 1] })
      if (controls.fail) return yield* Effect.fail(new Error('private SDK token'))
      if (controls.hold) yield* Deferred.await(completion)
      phase = readyState
    })
  })
  return { integration, context, writes, registered, controls, completion }
}

describe('integration base', () => {
  it('keeps inspection read-only and publishes checked progress after explicit installation', async () => {
    const p = provider()
    expect(await run(p.integration.check(p.context))).toEqual({ state: 'setup_required', actionIds: [] })
    expect(p.writes).toEqual([])
    expect(p.registered).toEqual([])
    await run(p.integration.install(p.context))
    expect(p.writes).toEqual([
      { state: 'preparing', data: { provider: 'notes' } },
      { state: 'account_required', data: { actionIds: ['connect'] } }
    ])
    expect(p.registered).toEqual(['pages'])
    expect(p.controls.calls).toBe(0)
  })

  it('validates static and currently available actions, preserving opaque callback data', async () => {
    const p = provider()
    await expect(run(p.integration.onActionCallback(p.context, 'connect'))).rejects.toThrow('no longer available')
    await run(p.integration.install(p.context))
    await expect(run(p.integration.onActionCallback(p.context, 'unknown'))).rejects.toThrow('Unknown integration action')
    const payload = { callback: ['text', 123] }
    await run(p.integration.onActionCallback(p.context, 'connect', payload))
    expect(p.controls.payload).toEqual(payload)
    expect(p.writes.at(-1)).toEqual({ state: readyState, data: { actionIds: [] } })
    await expect(run(p.integration.onActionCallback(p.context, 'connect'))).rejects.toThrow('no longer available')
    expect(p.controls.calls).toBe(1)
  })

  it('serializes duplicate actions while checks and other providers remain independent', async () => {
    const first = provider('notes')
    const second = provider('calendar')
    await run(first.integration.install(first.context))
    await run(second.integration.install(second.context))
    first.controls.hold = true
    const attempts = Promise.allSettled([
      run(first.integration.onActionCallback(first.context, 'connect')),
      run(first.integration.onActionCallback(first.context, 'connect'))
    ])
    try {
      await vi.waitFor(() => expect(first.writes.at(-1)?.state).toBe('waiting_for_account'))
      expect(await run(first.integration.check(first.context))).toEqual({ state: 'waiting_for_account', actionIds: [] })
      await run(second.integration.onActionCallback(second.context, 'connect'))
      expect(await run(second.integration.check(second.context))).toEqual({ state: readyState, actionIds: [] })
    } finally { await Effect.runPromise(Deferred.succeed(first.completion, undefined)) }
    expect((await attempts).map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(first.controls.calls).toBe(1)
  })

  it('clears failed progress, sanitizes unknown errors and allows retry', async () => {
    const p = provider()
    await run(p.integration.install(p.context))
    p.controls.fail = true
    const failure = await run(Effect.flip(p.integration.onActionCallback(p.context, 'connect')))
    expect(failure._tag).toBe('IntegrationError')
    expect(JSON.stringify(failure)).not.toContain('private SDK token')
    expect(p.writes.at(-1)?.state).toBe('action_failed')
    expect((await run(p.integration.check(p.context))).state).toBe('account_required')
    p.controls.fail = false
    await run(p.integration.onActionCallback(p.context, 'connect'))
    expect((await run(p.integration.check(p.context))).state).toBe(readyState)
  })

  it('clears live state even when persisting the failure also fails', async () => {
    const p = provider()
    p.controls.failWrite = true
    await expect(run(p.integration.install(p.context))).rejects.toThrow()
    expect((await run(p.integration.check(p.context))).state).toBe('setup_required')
    p.controls.failWrite = false
    await run(p.integration.install(p.context))
    expect((await run(p.integration.check(p.context))).state).toBe('account_required')
  })

  it('cancels waiting actions, ignores completed callbacks and releases the lock for retry', async () => {
    const p = provider()
    await run(p.integration.install(p.context))
    p.controls.hold = true
    const controller = new AbortController()
    const attempt = run(p.integration.onActionCallback(p.context, 'connect'), controller.signal)
    const cancelled = expect(attempt).rejects.toThrow()
    try { await vi.waitFor(() => expect(p.writes.at(-1)?.state).toBe('waiting_for_account')) }
    finally { controller.abort() }
    await cancelled
    expect(p.writes.at(-1)?.state).toBe('cancelled')
    const late = p.controls.tracked!
    p.controls.hold = false
    await run(p.integration.onActionCallback(p.context, 'connect'))
    await run(late.writeState('obsolete', { stale: true }))
    expect(p.writes.at(-1)?.state).toBe(readyState)
    expect((await run(p.integration.check(p.context))).state).toBe(readyState)
  })
})
