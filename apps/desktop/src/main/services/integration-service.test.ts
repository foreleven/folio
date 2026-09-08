import { NodeServices } from '@effect/platform-node'
import { IntegrationError, type Integration } from '@folio/integrations'
import { ConfigProvider, Deferred, Effect, Layer, ManagedRuntime, Option, Stream } from 'effect'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IntegrationBrowser } from '../electron/IntegrationBrowser'
import { ConfigService } from './config-service'
import { IntegrationCatalog, IntegrationService } from './integration-service'
import { IntegrationStore } from './integration-store'
import type { IntegrationView } from '../../shared/integration'

let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'folio-integration-desktop-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

/** Fake provider holds OAuth in flight while exercising the real SQL store, stream, and service scope. */
function fixture() {
  let phase = 'install_required'
  const authorization = Effect.runSync(Deferred.make<void>())
  const state = { installs: 0, checks: 0, actions: 0, failInstall: false, failCheck: false, url: 'https://accounts.feishu.cn/authorize' }
  const resource = { id: 'im', name: 'Messages', onIngest: () => Effect.void }
  const integration: Integration = {
    id: 'lark', name: 'Lark', resources: [resource], actions: [{ id: 'install', label: 'Install' }, { id: 'authorize', label: 'Authorize' }],
    install: (context) => Effect.gen(function*() {
      state.installs++
      yield* context.writeState('installing', { progress: 1 })
      if (state.failInstall) return yield* new IntegrationError({ message: 'private diagnostic' })
      yield* context.registerResource(resource)
      phase = 'login_required'
    }),
    check: () => Effect.gen(function*() {
      state.checks++
      if (state.failCheck) return yield* new IntegrationError({ message: 'network error' })
      return { state: phase, actionIds: phase === 'ready' ? [] : [phase === 'install_required' ? 'install' : 'authorize'] }
    }),
    onActionCallback: (context, action) => action === 'install' ? integration.install(context) : Effect.gen(function*() {
      state.actions++
      yield* context.writeState('waiting_for_user', { url: state.url, providerData: { arbitrary: ['kept', 1] } })
      yield* Deferred.await(authorization)
      phase = 'ready'
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
  return { runtime, service, settled, state, opened, authorization, layer }
}

/** Queries the physical table from another connection to prove actual SQLite persistence. */
function rows() {
  const db = new DatabaseSync(join(directory, 'data.db'), { readOnly: true })
  try { return db.prepare('SELECT * FROM integration_states').all() } finally { db.close() }
}

describe('desktop integration lifecycle', () => {
  it('browsing creates no rows; install inserts one row and commits provider data/resources', async () => {
    const f = fixture()
    try {
      const s = await f.service()
      const initial = await f.runtime.runPromise(Stream.runHead(s.watch))
      expect(initial).toBeDefined()
      expect(rows()).toEqual([])
      expect(f.state.installs).toBe(0)
      await f.runtime.runPromise(s.install('lark'))
      expect(rows()).toHaveLength(1)
      const result = await f.settled('login_required')
      expect(result.record?.actionIds).toEqual(['authorize'])
      expect(result.record?.resources).toEqual([{ id: 'im', name: 'Messages' }])
      expect(f.state.checks).toBeGreaterThan(0)
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
      await f.runtime.runPromise(s.install('lark'))
      await f.settled('login_required')
      await f.runtime.runPromise(s.action('lark', 'authorize').pipe(Effect.scoped))
      await vi.waitFor(async () => {
        const view = (await f.runtime.runPromise(s.list))[0]
        expect(view.record?.state).toBe('waiting_for_user')
        expect(view.busy).toBe(true)
      })
      await vi.waitFor(() => expect(snapshots.at(-1)?.record?.state).toBe('waiting_for_user'))
      expect(snapshots.some((view) => view.record?.state === 'installing')).toBe(true)
      const reconnected = Option.getOrThrow(await f.runtime.runPromise(Stream.runHead(s.watch)))
      expect(reconnected[0]).toEqual(snapshots.at(-1))
      // Closing every current subscription must not cancel the host-owned authorization job.
      subscriber.abort()
      await watching
      await f.runtime.runPromise(s.openAuthorization('lark'))
      expect(f.opened).toEqual([f.state.url])
      expect(JSON.parse(String(rows()[0].data))).toEqual({ url: f.state.url, providerData: { arbitrary: ['kept', 1] } })
      await f.runtime.runPromise(s.action('lark', 'authorize'))
      expect(f.state.actions).toBe(1)
      await f.runtime.runPromise(Deferred.succeed(f.authorization, undefined))
      await f.settled('ready')
      const completed = Option.getOrThrow(await f.runtime.runPromise(Stream.runHead(s.watch)))
      expect(completed[0]).toMatchObject({ busy: false, record: { state: 'ready' } })
      expect(rows()).toHaveLength(1)
      expect(JSON.parse(String(rows()[0].data))).toEqual({})
      await expect(f.runtime.runPromise(s.openAuthorization('lark'))).rejects.toThrow()
    } finally { subscriber.abort(); await watching; await f.runtime.dispose() }
  })

  it('persists failures and offers a retry without exposing provider diagnostics', async () => {
    const f = fixture()
    f.state.failInstall = true
    try {
      const s = await f.service()
      await f.runtime.runPromise(s.install('lark'))
      const result = await f.settled('install_required')
      expect(result.record?.error).toBeTruthy()
      expect(JSON.stringify(result)).not.toContain('private diagnostic')
      f.state.failInstall = false
      await f.runtime.runPromise(s.action('lark', 'install'))
      const recovered = await f.settled('login_required')
      expect(recovered.record?.error).toBeNull()
      expect(rows()).toHaveLength(1)
    } finally { await f.runtime.dispose() }
  })

  it('rechecks persisted waiting state after process restart instead of reopening an expired URL', async () => {
    const f = fixture()
    const s = await f.service()
    await f.runtime.runPromise(s.install('lark'))
    await f.settled('login_required')
    await f.runtime.runPromise(s.action('lark', 'authorize'))
    await vi.waitFor(() => expect(rows()[0].state).toBe('waiting_for_user'))
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
      await expect(f.runtime.runPromise(s.action('lark', 'authorize'))).rejects.toThrow()
      await expect(f.runtime.runPromise(s.check('lark'))).rejects.toThrow()
      expect(rows()).toEqual([])
    } finally { await f.runtime.dispose() }
  })

  it('rejects unsafe stored authorization destinations', async () => {
    const f = fixture()
    f.state.url = 'https://accounts.feishu.cn.evil.example/steal'
    try {
      const s = await f.service()
      await f.runtime.runPromise(s.install('lark'))
      await f.settled('login_required')
      await f.runtime.runPromise(s.action('lark', 'authorize'))
      await vi.waitFor(() => expect(rows()[0].state).toBe('waiting_for_user'))
      await expect(f.runtime.runPromise(s.openAuthorization('lark'))).rejects.toThrow()
      expect(f.opened).toEqual([])
    } finally { await f.runtime.dispose() }
  })

  it('surfaces unavailable checks without discarding registered resources', async () => {
    const f = fixture()
    try {
      const s = await f.service()
      await f.runtime.runPromise(s.install('lark'))
      await f.settled('login_required')
      f.state.failCheck = true
      await f.runtime.runPromise(s.check('lark'))
      const result = await f.settled('check_failed')
      expect(result.record?.resources).toHaveLength(1)
      expect(result.record?.error).toBeTruthy()
      f.state.failCheck = false
      await f.runtime.runPromise(s.check('lark'))
      await f.settled('login_required')
    } finally { await f.runtime.dispose() }
  })
})
