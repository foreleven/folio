import { NodeServices } from '@effect/platform-node'
import { IntegrationContext, IntegrationError, type Integration } from '@folio/integrations/base'
import { ConfigProvider, Deferred, Effect, Layer, ManagedRuntime, Option, Stream } from 'effect'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IntegrationBrowser } from '../electron/IntegrationBrowser'
import { ConfigService } from './config-service'
import { IntegrationService } from './integration-service'
import { IntegrationCatalog } from './integration-catalog'
import { IntegrationStore } from './integration-store'
import type { IntegrationView } from '../../shared/integration'

let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'folio-integration-desktop-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

/** Fake provider holds OAuth in flight while exercising the real SQL store, stream, and service scope. */
function fixture(background = false, form = false) {
  let phase = 'install_required'
  let awaiting = false
  const authorization = Effect.runSync(Deferred.make<void>())
  const checkStarted = Effect.runSync(Deferred.make<void>())
  const checkResume = Effect.runSync(Deferred.make<void>())
  const state = { installs: 0, healthChecks: 0, inspections: 0, actions: 0, failInstall: false, failHealthCheck: false, failInspect: false, holdCheck: false, context: undefined as IntegrationContext["Service"] | undefined, payload: undefined as unknown, starts: 0, stops: 0, url: 'https://accounts.notes.example/connect' }
  const resource = { id: 'im', name: 'Messages', onIngest: () => Effect.void }
  const integration: Integration = {
    id: 'notes', name: 'Notes', description: 'Test provider', states: {}, logo: 'data:image/svg+xml,%3Csvg%2F%3E', homepage: 'https://example.test',
    run: background ? () => Effect.gen(function*() { state.starts++; state.context = yield* IntegrationContext; yield* Effect.never }).pipe(Effect.ensuring(Effect.sync(() => { state.stops++ }))) : undefined,
    resources: [resource], actions: [{ id: 'install', label: 'Install' }, { id: 'authorize', label: 'Authorize', fields: form ? [{ id: 'accessKey', label: 'AccessKey', type: 'password', required: true }] : undefined }, { id: 'open', label: 'Open account page' }],
    install: () => Effect.gen(function*() {
      const context = yield* IntegrationContext
      state.context = context
      state.installs++
      yield* context.writeState('installing', { progress: 1 })
      if (state.failInstall) return yield* new IntegrationError({ message: 'private diagnostic' })
      yield* context.registerResource(resource)
      phase = 'login_required'
    }),
    check: () => Effect.gen(function*() {
      state.healthChecks++
      if (state.failHealthCheck) return yield* new IntegrationError({ message: 'health check error' })
    }),
    inspect: () => Effect.gen(function*() {
      state.inspections++
      if (state.failInspect) return yield* new IntegrationError({ message: 'inspection error' })
      const snapshot = awaiting ? { state: 'awaiting_browser', actions: [{ id: 'open', type: 'open-url' as const, url: state.url }] }
        : { state: phase, actions: phase === 'ready' ? [] : [{ id: phase === 'install_required' ? 'install' : 'authorize', type: 'callback' as const }] }
      if (state.holdCheck) { yield* Deferred.succeed(checkStarted, undefined); yield* Deferred.await(checkResume) }
      return snapshot
    }),
    onActionCallback: (action, payload) => action === 'install' ? integration.install() : Effect.gen(function*() {
      const context = yield* IntegrationContext
      state.actions++
      state.payload = payload
      awaiting = true
      yield* Effect.gen(function*() {
        yield* context.writeState('awaiting_browser', { providerData: { arbitrary: ['kept', 1] } }, [{ id: 'open', type: 'open-url', url: state.url }])
        yield* Deferred.await(authorization)
        phase = 'ready'
      }).pipe(Effect.ensuring(Effect.sync(() => { awaiting = false })))
    })
  }
  const opened: string[] = []
  const layer = IntegrationService.layer.pipe(
    Layer.provideMerge(IntegrationStore.layer),
    Layer.provide(Layer.succeed(IntegrationCatalog)([integration])),
    Layer.provide(Layer.succeed(IntegrationBrowser)({ open: (url) => Effect.sync(() => { opened.push(url) }) })),
    Layer.provide(ConfigService.layer), Layer.provide(NodeServices.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ FOLIO_CONFIG_DIR: directory })))
  )
  const runtime = ManagedRuntime.make(layer)
  const service = () => runtime.runPromise(IntegrationService)
  /** Waits for a committed snapshot rather than assuming a forked operation finished. */
  const settled = async (expected: string) => vi.waitFor(async () => {
    const view = await runtime.runPromise(Effect.flatMap(IntegrationService, (s) => s.list))
    expect(view[0].busy).toBe(false)
    expect(view[0].record?.state).toBe(expected)
    return view[0]
  }, { timeout: 5000, interval: 10 })
  return { runtime, service, settled, state, opened, authorization, layer, integration, checkStarted, checkResume,
    commit: (next: string) => state.context!.writeState(next, {}, []),
    publish: (next: string) => Effect.gen(function*() { phase = next; yield* state.context!.writeState(next, {}, []) }) }
}

/** Queries the physical table from another connection to prove actual SQLite persistence. */
function rows() {
  const db = new DatabaseSync(join(directory, 'data.db'), { readOnly: true })
  try { return db.prepare('SELECT * FROM integration_states').all() } finally { db.close() }
}

describe('desktop integration lifecycle', () => {
  it('migrates legacy action IDs without losing resources or reopening a persisted URL', async () => {
    const db = new DatabaseSync(join(directory, 'data.db'))
    try {
      db.exec(`CREATE TABLE integration_states (
        id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}',
        action_ids TEXT NOT NULL DEFAULT '[]', resources TEXT NOT NULL DEFAULT '[]', error TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )`)
      db.prepare('INSERT INTO integration_states VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        'notes', 'old_provider_wait', JSON.stringify({ url: 'https://expired.example' }),
        JSON.stringify(['authorize']), JSON.stringify([{ id: 'im', name: 'Messages' }]), null, 1, 2
      )
    } finally { db.close() }
    const f = fixture()
    try {
      const s = await f.service()
      const view = await f.settled('install_required')
      expect(view.record?.resources).toEqual([{ id: 'im', name: 'Messages' }])
      expect(view.record?.actions).toEqual([{ id: 'install', type: 'callback' }])
      expect(view.record?.data).toEqual({})
      expect(view.record?.createdAt).toBe(1)
      expect(f.state.installs).toBe(0)
      await expect(f.runtime.runPromise(s.action('notes', 'open'))).rejects.toThrow()
      expect(f.opened).toEqual([])
      expect(JSON.parse(String(rows()[0].actions))).toEqual([{ id: 'install', type: 'callback' }])
    } finally { await f.runtime.dispose() }
  })

  it('browsing creates no rows; install inserts one row and commits provider data/resources', async () => {
    const f = fixture()
    try {
      const s = await f.service()
      const initial = await f.runtime.runPromise(Stream.runHead(s.watch))
      expect(initial).toBeDefined()
      expect(Option.getOrThrow(initial)[0]).toMatchObject({
        description: 'Test provider', states: {}, logo: 'data:image/svg+xml,%3Csvg%2F%3E', homepage: 'https://example.test'
      })
      expect(rows()).toEqual([])
      expect(f.state.installs).toBe(0)
      await f.runtime.runPromise(s.install('notes'))
      expect(rows()).toHaveLength(1)
      const result = await f.settled('login_required')
      expect(result.record?.actions.map((action) => action.id)).toEqual(['authorize'])
      expect(result.record?.resources).toEqual([{ id: 'im', name: 'Messages' }])
      expect(f.state.inspections).toBeGreaterThan(0)
    } finally { await f.runtime.dispose() }
  })

  it('keeps OAuth alive after the requesting scope ends and streams opaque data to a new subscriber', async () => {
    const f = fixture()
    const subscriber = new AbortController()
    let watching: Promise<unknown> | undefined
    try {
      const s = await f.service()
      const snapshots: IntegrationView[] = []
      watching = f.runtime.runPromise(s.watch.pipe(
        Stream.runForEach((views) => Effect.sync(() => { snapshots.push(views[0]) }))
      ), { signal: subscriber.signal }).catch(() => undefined)
      await vi.waitFor(() => expect(snapshots[0]?.record).toBeNull())
      await f.runtime.runPromise(s.install('notes'))
      await f.settled('login_required')
      await f.runtime.runPromise(s.action('notes', 'authorize').pipe(Effect.scoped))
      await vi.waitFor(async () => {
        const view = (await f.runtime.runPromise(s.list))[0]
        expect(view.record?.state).toBe('awaiting_browser')
        expect(view.busy).toBe(true)
      })
      await vi.waitFor(() => expect(snapshots.at(-1)?.record?.state).toBe('awaiting_browser'))
      expect(snapshots.some((view) => view.record?.state === 'installing')).toBe(true)
      const reconnected = Option.getOrThrow(await f.runtime.runPromise(Stream.runHead(s.watch)))
      expect(reconnected[0]).toEqual(snapshots.at(-1))
      // Closing every current subscription must not cancel the host-owned authorization job.
      subscriber.abort()
      await watching
      await f.runtime.runPromise(s.action('notes', 'open'))
      expect(f.opened).toEqual([f.state.url])
      expect(JSON.parse(String(rows()[0].actions))).toEqual([{ id: 'open', type: 'open-url', url: f.state.url }])
      expect(JSON.parse(String(rows()[0].data))).toEqual({ providerData: { arbitrary: ['kept', 1] } })
      await expect(f.runtime.runPromise(s.action('notes', 'authorize'))).rejects.toThrow()
      expect(f.state.actions).toBe(1)
      await f.runtime.runPromise(Deferred.succeed(f.authorization, undefined))
      await f.settled('ready')
      const completed = Option.getOrThrow(await f.runtime.runPromise(Stream.runHead(s.watch)))
      expect(completed[0]).toMatchObject({ busy: false, record: { state: 'ready' } })
      expect(rows()).toHaveLength(1)
      expect(JSON.parse(String(rows()[0].data))).toEqual({})
      await expect(f.runtime.runPromise(s.action('notes', 'open'))).rejects.toThrow()
    } finally { subscriber.abort(); await watching; await f.runtime.dispose() }
  })

  it('persists failures and offers a retry without exposing provider diagnostics', async () => {
    const f = fixture()
    f.state.failInstall = true
    try {
      const s = await f.service()
      await f.runtime.runPromise(s.install('notes'))
      const result = await f.settled('install_required')
      expect(result.record?.error).toBeTruthy()
      expect(JSON.stringify(result)).not.toContain('private diagnostic')
      f.state.failInstall = false
      await f.runtime.runPromise(s.action('notes', 'install'))
      const recovered = await f.settled('login_required')
      expect(recovered.record?.error).toBeNull()
      expect(rows()).toHaveLength(1)
    } finally { await f.runtime.dispose() }
  })

  it('rechecks persisted waiting state after process restart instead of reopening an expired URL', async () => {
    const f = fixture()
    const s = await f.service()
    await f.runtime.runPromise(s.install('notes'))
    await f.settled('login_required')
    await f.runtime.runPromise(s.action('notes', 'authorize'))
    await vi.waitFor(() => expect(rows()[0].state).toBe('awaiting_browser'))
    await f.runtime.dispose()
    const next = ManagedRuntime.make(f.layer)
    try {
      const nextService = await next.runPromise(IntegrationService)
      await vi.waitFor(async () => {
        const view = (await next.runPromise(nextService.list))[0]
        expect(view.busy).toBe(false)
        expect(view.record?.state).toBe('login_required')
        expect(view.record?.data).toEqual({})
      })
      expect(rows()).toHaveLength(1)
      expect(f.state.installs).toBe(1)
    } finally { await next.dispose() }
  })

  it('rejects uninstalled/unknown actions without inserting rows', async () => {
    const f = fixture()
    try {
      const s = await f.service()
      await expect(f.runtime.runPromise(s.install('../other'))).rejects.toThrow()
      await expect(f.runtime.runPromise(s.action('notes', 'authorize'))).rejects.toThrow()
      await expect(f.runtime.runPromise(s.inspect('notes'))).rejects.toThrow()
      expect(rows()).toEqual([])
    } finally { await f.runtime.dispose() }
  })

  it.each(['javascript:alert(1)', 'file:///tmp/credentials', 'http://accounts.notes.example', 'https://user:secret@accounts.notes.example'])('rejects unsupported external action URLs: %s', async (url) => {
    const f = fixture()
    f.state.url = url
    try {
      const s = await f.service()
      await f.runtime.runPromise(s.install('notes'))
      await f.settled('login_required')
      await f.runtime.runPromise(s.action('notes', 'authorize'))
      await vi.waitFor(() => expect(rows()[0].state).toBe('awaiting_browser'))
      await expect(f.runtime.runPromise(s.action('notes', 'open'))).rejects.toThrow()
      expect(f.opened).toEqual([])
    } finally { await f.runtime.dispose() }
  })

  it('preserves a ready snapshot after a successful lightweight check and falls back to inspect on failure', async () => {
    const f = fixture()
    try {
      const s = await f.service()
      await f.runtime.runPromise(s.install('notes'))
      await f.settled('login_required')
      await f.runtime.runPromise(f.commit('ready'))
      const inspections = f.state.inspections

      await f.runtime.runPromise(s.inspect('notes'))
      await f.settled('ready')
      expect(f.state.healthChecks).toBe(1)
      expect(f.state.inspections).toBe(inspections)

      f.state.failHealthCheck = true
      await f.runtime.runPromise(s.inspect('notes'))
      await f.settled('login_required')
      expect(f.state.healthChecks).toBe(2)
      expect(f.state.inspections).toBe(inspections + 1)
    } finally { await f.runtime.dispose() }
  })

  it('surfaces unavailable inspections without discarding registered resources', async () => {
    const f = fixture()
    try {
      const s = await f.service()
      await f.runtime.runPromise(s.install('notes'))
      await f.settled('login_required')
      f.state.failInspect = true
      await f.runtime.runPromise(s.inspect('notes'))
      const result = await f.settled('check_failed')
      expect(result.record?.resources).toHaveLength(1)
      expect(result.record?.error).toBeTruthy()
      f.state.failInspect = false
      await f.runtime.runPromise(s.inspect('notes'))
      await f.settled('login_required')
    } finally { await f.runtime.dispose() }
  })
  it('passes form inputs only to the callback and never stores or streams credentials', async () => {
    const f = fixture(false, true)
    try {
      const s = await f.service()
      await f.runtime.runPromise(s.install('notes'))
      await f.settled('login_required')
      for (const invalid of [undefined, {}, { accessKey: '   ' }]) {
        await expect(f.runtime.runPromise(s.action('notes', 'authorize', invalid))).rejects.toThrow()
      }
      expect(f.state.actions).toBe(0)
      const payload = { accessKey: 'test-private-access-key' }
      await f.runtime.runPromise(s.action('notes', 'authorize', payload))
      await vi.waitFor(() => expect(f.state.payload).toEqual(payload))
      expect(JSON.stringify(rows())).not.toContain(payload.accessKey)
      expect(JSON.stringify(await f.runtime.runPromise(s.list))).not.toContain(payload.accessKey)
      await f.runtime.runPromise(Deferred.succeed(f.authorization, undefined))
      await f.settled('ready')
    } finally { await f.runtime.dispose() }
  })

  it('starts a provider lifetime once after installation and stops it with the host scope', async () => {
    const f = fixture(true)
    const s = await f.service()
    expect(f.state.starts).toBe(0)
    await f.runtime.runPromise(s.install('notes'))
    await f.settled('login_required')
    await f.runtime.runPromise(s.inspect('notes'))
    await f.settled('login_required')
    expect(f.state.starts).toBe(1)
    expect(f.state.stops).toBe(0)
    await f.runtime.dispose()
    expect(f.state.stops).toBe(1)
    const next = ManagedRuntime.make(f.layer)
    try {
      await next.runPromise(IntegrationService)
      await vi.waitFor(() => expect(f.state.starts).toBe(2))
      expect(f.state.installs).toBe(1)
    } finally { await next.dispose() }
    expect(f.state.stops).toBe(2)
  })

  it('does not replace a newer background publication with an inspection that began earlier', async () => {
    const f = fixture(true)
    try {
      const s = await f.service()
      await f.runtime.runPromise(s.install('notes'))
      await f.settled('login_required')
      f.state.holdCheck = true
      await f.runtime.runPromise(s.inspect('notes'))
      await f.runtime.runPromise(Deferred.await(f.checkStarted))
      await f.runtime.runPromise(f.publish('ready'))
      await f.runtime.runPromise(Deferred.succeed(f.checkResume, undefined))
      await f.settled('ready')
      expect(rows()[0].state).toBe('ready')
    } finally { await f.runtime.dispose() }
  })

})
