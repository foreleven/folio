import { IntegrationError } from '@folio/integrations/base'
import type { Integration, IntegrationContext, IntegrationEffect } from '@folio/integrations/base'
import { lark } from '@folio/integrations/lark'
import { Context, Effect, FileSystem, Layer, PubSub, Schema, Scope, Semaphore, Stream } from 'effect'
import { ChildProcessSpawner } from 'effect/unstable/process'
import { join } from 'node:path'
import { IntegrationSettingsError, type IntegrationView } from '../../shared/integration'
import { IntegrationBrowser } from '../electron/IntegrationBrowser'
import { ConfigService } from './config-service'
import { IntegrationStore } from './integration-store'

/** The host's static registry; tests substitute integrations without contacting Lark. */
export class IntegrationCatalog extends Context.Service<IntegrationCatalog, readonly Integration[]>()('folio/services/IntegrationCatalog') {
  static readonly layer = Layer.succeed(IntegrationCatalog)([lark])
}
const failure = () => new IntegrationSettingsError({ message: 'The integration operation failed. Check its status and try again.' })

/** Owns process-lifetime jobs, SQLite state, and a push stream shared by all settings windows. */
export class IntegrationService extends Context.Service<IntegrationService, {
  readonly watch: Stream.Stream<readonly IntegrationView[], IntegrationSettingsError>
  readonly list: Effect.Effect<readonly IntegrationView[], IntegrationSettingsError>
  readonly install: (id: string) => Effect.Effect<void, IntegrationSettingsError>
  readonly check: (id: string) => Effect.Effect<void, IntegrationSettingsError>
  readonly action: (id: string, actionId: string) => Effect.Effect<void, IntegrationSettingsError>
  readonly openAuthorization: (id: string) => Effect.Effect<void, IntegrationSettingsError>
}>()('folio/services/IntegrationService') {
  static readonly layer = Layer.effect(IntegrationService, Effect.gen(function*() {
    const catalog = yield* IntegrationCatalog
    const store = yield* IntegrationStore
    const config = yield* ConfigService
    const browser = yield* IntegrationBrowser
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const scope = yield* Scope.Scope
    const commands = yield* Semaphore.make(1)
    const writes = yield* Semaphore.make(1)
    const running = new Set<string>()
    const changes = yield* PubSub.unbounded<readonly IntegrationView[]>()
    yield* Effect.addFinalizer(() => PubSub.shutdown(changes))

    const list = Effect.gen(function*() {
      const rows = yield* store.list
      return catalog.map((integration) => ({
        id: integration.id, name: integration.name, actions: integration.actions,
        description: integration.description, logo: integration.logo, homepage: integration.homepage,
        resources: integration.resources.map(({ id, name }) => ({ id, name })),
        record: rows.find((row) => row.id === integration.id) ?? null,
        busy: running.has(integration.id)
      }))
    })
    /** Publishes only committed snapshots; shares a lock with watch subscription's initial read. */
    const commit = <A>(effect: Effect.Effect<A, IntegrationSettingsError>) => effect.pipe(
      Effect.tap(() => Effect.flatMap(list, (snapshot) => PubSub.publish(changes, snapshot))),
      writes.withPermit, Effect.uninterruptible
    )
    const watch = Stream.unwrap(Effect.gen(function*() {
      const { subscription, initial } = yield* Effect.gen(function*() {
        const subscription = yield* PubSub.subscribe(changes)
        return { subscription, initial: yield* list }
      }).pipe(writes.withPermit)
      return Stream.concat(Stream.succeed(initial), Stream.fromSubscription(subscription))
    }))
    const withPlatform = <A>(effect: IntegrationEffect<A>) => effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
    )
    /** Adapts opaque state/resource callbacks to the app store without exposing SQL to integrations. */
    const contextFor = (id: string): IntegrationContext => ({
      directory: join(config.directory, 'integrations', id),
      writeState: (state, data) => commit(store.update(id, state, data, [])).pipe(
        Effect.mapError(() => new IntegrationError({ message: 'Could not persist integration state.' }))
      ),
      registerResource: ({ id: resourceId, name }) => commit(store.register(id, { id: resourceId, name })).pipe(
        Effect.mapError(() => new IntegrationError({ message: 'Could not register integration resource.' }))
      )
    })
    /** Rechecks facts at the end of every stage and records exactly the actions currently available. */
    const reconcile = Effect.fn('IntegrationService.reconcile')(function*(integration: Integration) {
      const result = yield* withPlatform(integration.check(contextFor(integration.id)))
      const row = (yield* store.list).find((row) => row.id === integration.id)!
      // Completed/expired attempts must not keep old authorization URLs available.
      const data = result.state === row.state ? row.data : {}
      yield* commit(store.update(integration.id, result.state, data, result.actionIds))
    })
    /** Starts a main-scope job, independent of the lifetime of the requesting RPC/window. */
    const start = Effect.fn('IntegrationService.start')(function*(id: string, operation: 'install' | 'check' | 'action', actionId?: string) {
      const integration = catalog.find((item) => item.id === id)
      if (!integration) return yield* new IntegrationSettingsError({ message: 'Unknown integration.' })
      if (running.has(id)) return
      const row = (yield* store.list).find((item) => item.id === id)
      if (!row && operation !== 'install') return yield* new IntegrationSettingsError({ message: 'Install this integration first.' })
      if (operation === 'action' && !integration.actions.some((item) => item.id === actionId)) {
        return yield* new IntegrationSettingsError({ message: 'Unknown integration action.' })
      }
      if (!row) yield* commit(store.create(id))
      running.add(id)
      const job = Effect.gen(function*() {
        yield* commit(store.update(id, 'checking', {}, []))
        if (operation === 'install') {
          // Even shared, already-ready tools must register their resources with this host.
          yield* withPlatform(integration.install(contextFor(id)))
        } else if (operation === 'action') {
          const checked = yield* withPlatform(integration.check(contextFor(id)))
          if (!checked.actionIds.includes(actionId!)) return yield* new IntegrationSettingsError({ message: 'This action is no longer available. Check again.' })
          yield* withPlatform(integration.onActionCallback(contextFor(id), actionId!))
        }
        yield* reconcile(integration)
      }).pipe(
        Effect.catch(() => Effect.gen(function*() {
          // Preserve durable progress; recover available actions from facts, then attach a safe error.
          const recovered = yield* reconcile(integration).pipe(Effect.as(true), Effect.catch(() => Effect.succeed(false)))
          const current = (yield* store.list).find((item) => item.id === id)!
          yield* commit(store.update(id, recovered ? current.state : 'check_failed',
            {}, recovered ? current.actionIds : [], 'The operation could not finish. Check the connection and try again.'))
        })),
        Effect.ensuring(Effect.gen(function*() {
          running.delete(id)
          yield* commit(Effect.void).pipe(Effect.catch(() => Effect.void))
        })),
        Effect.catch(() => Effect.void)
      )
      // The first row and job ownership survive renderer reload/cancellation together.
      yield* Effect.forkIn(job.pipe(Effect.interruptible), scope)
    }, commands.withPermit, Effect.uninterruptible, Effect.mapError(failure))
    /** Resolves the current trusted URL in main; renderer cannot request arbitrary external destinations. */
    const openAuthorization = Effect.fn('IntegrationService.openAuthorization')(function*(id: string) {
      const row = (yield* store.list).find((item) => item.id === id)
      if (!row || !running.has(id) || !['waiting_for_app', 'waiting_for_user'].includes(row.state)) return yield* failure()
      const data = yield* Schema.decodeUnknownEffect(Schema.Struct({ url: Schema.String }))(row.data)
      const url = yield* Effect.try(() => new URL(data.url))
      if (id !== 'lark' || url.protocol !== 'https:' || url.username || url.password || ![
        'open.feishu.cn', 'accounts.feishu.cn', 'open.larkoffice.com', 'accounts.larksuite.com', 'open.larksuite.com'
      ].includes(url.hostname)) return yield* failure()
      yield* browser.open(url.toString())
    }, Effect.mapError(failure))

    // Reconcile only installed rows on application restart; merely browsing never inserts rows.
    for (const row of yield* store.list) {
      if (catalog.some((item) => item.id === row.id)) yield* start(row.id, 'check')
    }
    return IntegrationService.of({ list, watch, install: (id) => start(id, 'install'), check: (id) => start(id, 'check'),
      action: (id, actionId) => start(id, 'action', actionId), openAuthorization })
  }))
}
