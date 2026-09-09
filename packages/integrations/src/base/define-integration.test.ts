import { Context, Deferred, Effect, Layer } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { defineIntegration, IntegrationContext, IntegrationError } from './index.ts'

/** Builds the callback protocol used by provider fixtures. */
const callback = (id: string) => ({ id, type: 'callback' as const })

/** Runs base effects with ordinary host services; no provider SDK or real credentials are involved. */
function run<A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal) {
  return Effect.runPromise(effect, { signal })
}

/** A second, deliberately non-Lark provider demonstrates the reusable lifecycle contract. */
function provider(id = 'notes', form = false) {
  let phase = 'setup_required'
  const completion = Effect.runSync(Deferred.make<void>())
  const writes: { state: string; data: unknown }[] = []
  const registered: string[] = []
  const controls = { hold: false, fail: false, failWrite: false, calls: 0, payload: undefined as unknown,
    tracked: undefined as IntegrationContext["Service"] | undefined }
  const context: IntegrationContext["Service"] = {
    directory: `/tmp/folio-base-test/${id}`,
    writeState: (state, data) => Effect.suspend(() => controls.failWrite
      ? Effect.fail(new IntegrationError({ message: 'State unavailable' }))
      : Effect.sync(() => { writes.push({ state, data }) })),
    registerResource: (resource) => Effect.sync(() => { registered.push(resource.id) })
  }
  const resource = { id: 'pages', name: 'Pages', onIngest: () => Effect.void }
  const integration = defineIntegration({
    id, name: 'Notes', description: 'Personal notes', homepage: 'https://notes.example',
    states: {}, logo: 'data:image/svg+xml,%3Csvg%2F%3E', resources: [resource],
    actions: [{ id: 'connect', label: 'Connect account', fields: form ? [{ id: 'accessKey', label: 'AccessKey', type: 'password', required: true }] : undefined }],
    inspect: () => Effect.succeed({ state: phase, actions: (phase === 'account_required' ? ['connect'] : []).map(callback) }),
    install: () => Effect.gen(function*() {
      const ctx = yield* IntegrationContext
      yield* ctx.writeState('preparing', { provider: id })
      yield* ctx.registerResource(resource)
      phase = 'account_required'
    }),
    onActionCallback: (_actionId, payload) => Effect.gen(function*() {
      const ctx = yield* IntegrationContext
      controls.calls++
      controls.payload = payload
      controls.tracked = ctx
      yield* ctx.writeState('waiting_for_account', { arbitrary: ['provider data', 1] })
      if (controls.fail) return yield* Effect.fail(new Error('private SDK token'))
      if (controls.hold) yield* Deferred.await(completion)
      phase = 'ready'
    })
  })
  return { integration, context, writes, registered, controls, completion }
}

describe('integration base', () => {
  it('preserves provider service requirements and scopes host overrides to each execution', async () => {
    class Account extends Context.Service<Account, { readonly name: string }>()('test/Account') {}
    const seen: string[] = []
    const integration = defineIntegration({
      id: 'account', name: 'Account', description: 'DI fixture', states: {}, logo: '', homepage: '', actions: [], resources: [],
      install: Effect.fn('Test.install')(function*() {
        const host = yield* IntegrationContext
        const account = yield* Account
        yield* host.writeState('preparing', account.name)
        seen.push(host.directory)
      }),
      inspect: Effect.fn('Test.inspect')(function*() {
        const account = yield* Account
        return { state: account.name, actions: [] }
      }),
      onActionCallback: () => Effect.void
    })
    const first = provider('first')
    const second = provider('second')
    const execute = (host: IntegrationContext['Service'], name: string) => run(Effect.gen(function*() {
      yield* integration.install()
      // The lifecycle's tracked override must not escape into the caller's environment.
      expect(yield* IntegrationContext).toBe(host)
      yield* (yield* IntegrationContext).writeState('outside', name)
    }).pipe(Effect.provide(Layer.mergeAll(
      Layer.succeed(IntegrationContext)(host), Layer.succeed(Account)({ name })
    ))))
    await Promise.all([execute(first.context, 'first'), execute(second.context, 'second')])
    expect(seen).toEqual([first.context.directory, second.context.directory])
    for (const [p, name] of [[first, 'first'], [second, 'second']] as const) {
      expect(p.writes).toEqual([
        { state: 'preparing', data: name },
        { state: name, data: {} },
        { state: 'outside', data: name }
      ])
    }
  })

  it('keeps inspection read-only and publishes checked progress after explicit installation', async () => {
    const p = provider()
    expect(await run(p.integration.inspect().pipe(Effect.provideService(IntegrationContext, p.context)))).toEqual({ state: 'setup_required', actions: [] })
    expect(p.writes).toEqual([])
    expect(p.registered).toEqual([])
    await run(p.integration.install().pipe(Effect.provideService(IntegrationContext, p.context)))
    expect(p.writes).toEqual([
      { state: 'preparing', data: { provider: 'notes' } },
      { state: 'account_required', data: {} }
    ])
    expect(p.registered).toEqual(['pages'])
    expect(p.controls.calls).toBe(0)
  })

  it('validates static and currently available actions, preserving opaque callback data', async () => {
    const p = provider()
    await expect(run(p.integration.onActionCallback('connect').pipe(Effect.provideService(IntegrationContext, p.context)))).rejects.toThrow('no longer available')
    await run(p.integration.install().pipe(Effect.provideService(IntegrationContext, p.context)))
    await expect(run(p.integration.onActionCallback('unknown').pipe(Effect.provideService(IntegrationContext, p.context)))).rejects.toThrow('Unknown integration action')
    const payload = { callback: ['text', 123] }
    await run(p.integration.onActionCallback('connect', payload).pipe(Effect.provideService(IntegrationContext, p.context)))
    expect(p.controls.payload).toEqual(payload)
    expect(p.writes.at(-1)).toEqual({ state: 'ready', data: {} })
    await expect(run(p.integration.onActionCallback('connect').pipe(Effect.provideService(IntegrationContext, p.context)))).rejects.toThrow('no longer available')
    expect(p.controls.calls).toBe(1)
  })

  it('never invokes a provider callback for an external action', async () => {
    const p = provider()
    const onActionCallback = vi.fn(() => Effect.void)
    const integration = defineIntegration({
      id: 'external', name: 'External', description: 'Protocol fixture', states: {}, logo: '', homepage: '', resources: [],
      actions: [{ id: 'open', label: 'Open setup' }],
      install: () => Effect.void,
      inspect: () => Effect.succeed({ state: 'attention', actions: [{ id: 'open', type: 'open-url' as const, url: 'https://provider.example' }] }),
      onActionCallback
    })
    await expect(run(integration.onActionCallback('open').pipe(Effect.provideService(IntegrationContext, p.context)))).rejects.toThrow('no longer available')
    expect(onActionCallback).not.toHaveBeenCalled()
    expect(p.writes).toEqual([])
  })

  it('serializes duplicate actions while checks and other providers remain independent', async () => {
    const first = provider('notes')
    const second = provider('calendar')
    await run(first.integration.install().pipe(Effect.provideService(IntegrationContext, first.context)))
    await run(second.integration.install().pipe(Effect.provideService(IntegrationContext, second.context)))
    first.controls.hold = true
    const attempts = Promise.allSettled([
      run(first.integration.onActionCallback('connect').pipe(Effect.provideService(IntegrationContext, first.context))),
      run(first.integration.onActionCallback('connect').pipe(Effect.provideService(IntegrationContext, first.context)))
    ])
    try {
      await vi.waitFor(() => expect(first.writes.at(-1)?.state).toBe('waiting_for_account'))
      expect(await run(first.integration.inspect().pipe(Effect.provideService(IntegrationContext, first.context)))).toEqual({ state: 'waiting_for_account', actions: [] })
      await run(second.integration.onActionCallback('connect').pipe(Effect.provideService(IntegrationContext, second.context)))
      expect(await run(second.integration.inspect().pipe(Effect.provideService(IntegrationContext, second.context)))).toEqual({ state: 'ready', actions: [] })
    } finally { await Effect.runPromise(Deferred.succeed(first.completion, undefined)) }
    expect((await attempts).map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(first.controls.calls).toBe(1)
  })

  it('clears failed progress, sanitizes unknown errors and allows retry', async () => {
    const p = provider()
    await run(p.integration.install().pipe(Effect.provideService(IntegrationContext, p.context)))
    p.controls.fail = true
    const failure = await run(Effect.flip(p.integration.onActionCallback('connect').pipe(Effect.provideService(IntegrationContext, p.context))))
    expect(failure._tag).toBe('IntegrationError')
    expect(JSON.stringify(failure)).not.toContain('private SDK token')
    expect(p.writes.at(-1)?.state).toBe('action_failed')
    expect((await run(p.integration.inspect().pipe(Effect.provideService(IntegrationContext, p.context)))).state).toBe('account_required')
    p.controls.fail = false
    await run(p.integration.onActionCallback('connect').pipe(Effect.provideService(IntegrationContext, p.context)))
    expect((await run(p.integration.inspect().pipe(Effect.provideService(IntegrationContext, p.context)))).state).toBe('ready')
  })

  it('clears live state even when persisting the failure also fails', async () => {
    const p = provider()
    p.controls.failWrite = true
    await expect(run(p.integration.install().pipe(Effect.provideService(IntegrationContext, p.context)))).rejects.toThrow()
    expect((await run(p.integration.inspect().pipe(Effect.provideService(IntegrationContext, p.context)))).state).toBe('setup_required')
    p.controls.failWrite = false
    await run(p.integration.install().pipe(Effect.provideService(IntegrationContext, p.context)))
    expect((await run(p.integration.inspect().pipe(Effect.provideService(IntegrationContext, p.context)))).state).toBe('account_required')
  })

  it('cancels waiting actions, ignores completed callbacks and releases the lock for retry', async () => {
    const p = provider()
    await run(p.integration.install().pipe(Effect.provideService(IntegrationContext, p.context)))
    p.controls.hold = true
    const controller = new AbortController()
    const attempt = run(p.integration.onActionCallback('connect').pipe(Effect.provideService(IntegrationContext, p.context)), controller.signal)
    const cancelled = expect(attempt).rejects.toThrow()
    try { await vi.waitFor(() => expect(p.writes.at(-1)?.state).toBe('waiting_for_account')) }
    finally { controller.abort() }
    await cancelled
    expect(p.writes.at(-1)?.state).toBe('cancelled')
    const late = p.controls.tracked!
    p.controls.hold = false
    await run(p.integration.onActionCallback('connect').pipe(Effect.provideService(IntegrationContext, p.context)))
    await run(late.writeState('obsolete', { stale: true }, [{ id: 'open', type: 'open-url', url: 'https://expired.example' }]))
    expect(p.writes.at(-1)?.state).toBe('ready')
    expect((await run(p.integration.inspect().pipe(Effect.provideService(IntegrationContext, p.context)))).state).toBe('ready')
  })
  it('validates declared inputs before provider side effects and never echoes submitted secrets', async () => {
    const p = provider('keys', true)
    await run(p.integration.install().pipe(Effect.provideService(IntegrationContext, p.context)))
    for (const payload of [undefined, {}, { accessKey: '   ' }, { accessKey: { secret: 'do-not-echo' } }]) {
      const error = await run(Effect.flip(p.integration.onActionCallback('connect', payload).pipe(Effect.provideService(IntegrationContext, p.context))))
      expect(error._tag).toBe('IntegrationError')
      expect(JSON.stringify(error)).not.toContain('do-not-echo')
      expect(p.controls.calls).toBe(0)
    }
    const payload = { accessKey: 'private-test-key' }
    await run(p.integration.onActionCallback('connect', payload).pipe(Effect.provideService(IntegrationContext, p.context)))
    expect(p.controls.payload).toEqual(payload)
    expect(JSON.stringify(p.writes)).not.toContain('private-test-key')
  })

})
