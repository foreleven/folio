import { IntegrationContext, IntegrationError } from '@folio/integrations/base'
import type { Integration, IntegrationEffect } from '@folio/integrations/base'
import { Context, Effect, FileSystem, Layer, PubSub, Schema, Scope, Semaphore, Stream } from 'effect'
import { ChildProcessSpawner } from 'effect/unstable/process'
import { join } from 'node:path'
import { IntegrationSettingsError, type IntegrationView } from '../../shared/integration'
import { IntegrationBrowser } from '../electron/IntegrationBrowser'
import { ConfigService } from './config-service'
import { IntegrationStore } from './integration-store'
import { IntegrationCatalog, type IntegrationPlatform } from './integration-catalog'
import { IntegrationAction } from '@folio/integrations/protocol'

const failure = () => new IntegrationSettingsError({ message: 'The integration operation failed. Check its status and try again.' })

/** Owns process-lifetime jobs, SQLite state, and a push stream shared by all settings windows. */
export class IntegrationService extends Context.Service<IntegrationService, {
  readonly watch: Stream.Stream<readonly IntegrationView[], IntegrationSettingsError>
  readonly list: Effect.Effect<readonly IntegrationView[], IntegrationSettingsError>
  readonly install: (id: string) => Effect.Effect<void, IntegrationSettingsError>
  readonly inspect: (id: string) => Effect.Effect<void, IntegrationSettingsError>
  readonly action: (id: string, actionId: string, payload?: unknown) => Effect.Effect<void, IntegrationSettingsError>
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
    const runtimes = new Set<string>()
    const revisions = new Map<string, number>()
    const changes = yield* PubSub.unbounded<readonly IntegrationView[]>()
    yield* Effect.addFinalizer(() => PubSub.shutdown(changes))
    yield* Effect.logDebug('Integration service initialization started').pipe(
      Effect.annotateLogs({ integrationCount: catalog.length })
    )

    const list = Effect.gen(function*() {
      const rows = yield* store.list
      return catalog.map((integration) => ({
        id: integration.id, name: integration.name, actions: integration.actions, states: integration.states,
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
    /** Supplies installation-local host capabilities and the app-owned platform implementations. */
    const withContext = <A>(id: string, effect: IntegrationEffect<A, IntegrationError, IntegrationPlatform>) => effect.pipe(
      Effect.provideService(IntegrationContext, contextFor(id)),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
    )
    /** Adapts opaque state/resource callbacks to the app store without exposing SQL to integrations. */
    const contextFor = (id: string): IntegrationContext["Service"] => ({
      directory: join(config.directory, 'integrations', id),
      writeState: (state, data, actions = []) => commit(store.update(id, state, data, actions).pipe(
        Effect.tap(() => Effect.sync(() => { revisions.set(id, (revisions.get(id) ?? 0) + 1) })),
        Effect.tap(() => Effect.logDebug('Integration state committed').pipe(
          Effect.annotateLogs({ integration: id, state, actionCount: actions.length })
        ))
      )).pipe(
        Effect.mapError(() => new IntegrationError({ message: 'Could not persist integration state.' }))
      ),
      registerResource: ({ id: resourceId, name }) => commit(store.register(id, { id: resourceId, name }).pipe(
        Effect.tap(() => Effect.logDebug('Integration resource registered').pipe(
          Effect.annotateLogs({ integration: id, resource: resourceId })
        ))
      )).pipe(Effect.mapError(() => new IntegrationError({ message: 'Could not register integration resource.' })))
    })
    /** Rechecks facts at the end of every stage and records exactly the actions currently available. */
    const reconcile = Effect.fn('IntegrationService.reconcile')(function*(integration: Integration<IntegrationPlatform>) {
      const revision = revisions.get(integration.id) ?? 0
      const result = yield* withContext(integration.id, integration.inspect())
      const row = (yield* store.list).find((row) => row.id === integration.id)!
      // Completed/expired attempts must not keep old authorization URLs available.
      const data = result.state === row.state ? row.data : {}
      // A background publication may finish while inspection is reading files/network facts.
      // Check inside the write lock so that an older inspection never replaces that newer snapshot.
      yield* commit(Effect.suspend(() => {
        if ((revisions.get(integration.id) ?? 0) !== revision) {
          return Effect.logDebug('Stale integration inspection ignored').pipe(
            Effect.annotateLogs({ integration: integration.id, state: result.state })
          )
        }
        return store.update(integration.id, result.state, data, result.actions).pipe(
          Effect.tap(() => Effect.logDebug('Integration reconciliation completed').pipe(
            Effect.annotateLogs({ integration: integration.id, state: result.state, actionCount: result.actions.length })
          ))
        )
      }))
    }, Effect.annotateLogs({ subsystem: 'integration-orchestration' }), Effect.withLogSpan('integration.reconcile'))
    /** Starts a main-scope job, independent of the lifetime of the requesting RPC/window. */
    const start = Effect.fn('IntegrationService.start')(function*(id: string, operation: 'install' | 'inspect' | 'action', actionId?: string, payload?: unknown) {
      const integration = catalog.find((item) => item.id === id)
      if (!integration) return yield* new IntegrationSettingsError({ message: 'Unknown integration.' })
      if (running.has(id)) return
      const row = (yield* store.list).find((item) => item.id === id)
      if (!row && operation !== 'install') return yield* new IntegrationSettingsError({ message: 'Install this integration first.' })
      if (operation === 'action' && !integration.actions.some((item) => item.id === actionId)) {
        return yield* new IntegrationSettingsError({ message: 'Unknown integration action.' })
      }
      if (!row) yield* commit(store.create(id))
      if (integration.run && !runtimes.has(id)) {
        runtimes.add(id)
        yield* Effect.logInfo('Integration provider runtime started').pipe(Effect.annotateLogs({ integration: id }))
        // The host owns cancellation only. Providers choose their own timers, retries and work.
        yield* withContext(id, integration.run()).pipe(
          Effect.tapError(() => Effect.logError('Integration provider runtime failed').pipe(
            Effect.annotateLogs({ integration: id })
          )),
          Effect.catch(() => commit(store.update(id, 'check_failed', {}, [], 'The connection could not be maintained. Check its status.'))),
          Effect.ensuring(Effect.logInfo('Integration provider runtime stopped').pipe(Effect.annotateLogs({ integration: id }))),
          Effect.catch(() => Effect.void), Effect.interruptible, Effect.forkIn(scope)
        )
      }
      running.add(id)
      yield* Effect.logInfo('Integration operation scheduled').pipe(
        Effect.annotateLogs({ integration: id, operation, action: actionId ?? 'none' })
      )
      const job = Effect.gen(function*() {
        yield* Effect.logInfo('Integration operation started').pipe(
          Effect.annotateLogs({ integration: id, operation, action: actionId ?? 'none' })
        )
        yield* commit(store.update(id, 'checking', {}, []))
        if (operation === 'install') {
          // Even shared, already-ready tools must register their resources with this host.
          yield* withContext(id, integration.install())
        } else if (operation === 'action') {
          const checked = yield* withContext(id, integration.inspect())
          if (!checked.actions.some((action) => action.id === actionId && action.type === 'callback')) return yield* new IntegrationSettingsError({ message: 'This action is no longer available. Check again.' })
          yield* withContext(id, integration.onActionCallback(actionId!, payload))
        }
        yield* reconcile(integration)
        yield* Effect.logInfo('Integration operation completed').pipe(
          Effect.annotateLogs({ integration: id, operation, action: actionId ?? 'none' })
        )
      }).pipe(
        Effect.catch(() => Effect.gen(function*() {
          yield* Effect.logError('Integration operation failed').pipe(
            Effect.annotateLogs({ integration: id, operation, action: actionId ?? 'none' })
          )
          // Preserve durable progress; recover available actions from facts, then attach a safe error.
          const failedAt = revisions.get(id) ?? 0
          const recovered = yield* reconcile(integration).pipe(Effect.as(true), Effect.catch(() => Effect.succeed(false)))
          const current = (yield* store.list).find((item) => item.id === id)!
          yield* commit(Effect.suspend(() => (revisions.get(id) ?? 0) === failedAt
            ? store.update(id, recovered ? current.state : 'check_failed', {}, recovered ? current.actions : [],
              'The operation could not finish. Check the connection and try again.') : Effect.void))
        })),
        Effect.ensuring(Effect.gen(function*() {
          running.delete(id)
          yield* commit(Effect.void).pipe(Effect.catch(() => Effect.void))
        })),
        Effect.catch(() => Effect.void)
      )
      // The first row and job ownership survive renderer reload/cancellation together.
      yield* Effect.forkIn(job.pipe(Effect.interruptible), scope)
    }, commands.withPermit, Effect.uninterruptible, Effect.mapError(failure),
    Effect.annotateLogs({ subsystem: 'integration-orchestration' }))
    /** Rechecks the provider's current action; the renderer supplies an ID, never a URL or protocol. */
    const action = Effect.fn('IntegrationService.action')(function*(id: string, actionId: string, payload?: unknown) {
      const integration = catalog.find((item) => item.id === id)
      if (!integration || !integration.actions.some((item) => item.id === actionId)) return yield* failure()
      if (!(yield* store.list).some((row) => row.id === id)) return yield* failure()
      const checked = yield* withContext(id, integration.inspect())
      const selected = yield* Schema.decodeUnknownEffect(IntegrationAction)(checked.actions.find((item) => item.id === actionId))
      switch (selected.type) {
        case 'callback':
          // Validate declared inputs before acknowledging the job; never persist submitted values.
          const definition = integration.actions.find((item) => item.id === actionId)!
          if (definition.fields?.length) {
            const values = yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.String))(payload)
            if (definition.fields.some((field) => field.required && !values[field.id]?.trim())) {
              return yield* new IntegrationSettingsError({ message: 'Complete the required fields.' })
            }
          }
          yield* start(id, 'action', actionId, payload)
          break
        case 'open-url':
          // Providers own domain policy. The host supports HTTPS navigation, never arbitrary OS schemes.
          const url = yield* Effect.try(() => new URL(selected.url))
          if (url.protocol !== 'https:' || url.username || url.password) return yield* failure()
          yield* Effect.logInfo('Opening integration authorization page').pipe(
            Effect.annotateLogs({ integration: id, action: actionId })
          )
          yield* browser.open(url.toString())
          break
      }
    }, Effect.mapError(failure))

    // Reconcile only installed rows on application restart; merely browsing never inserts rows.
    for (const row of yield* store.list) {
      if (catalog.some((item) => item.id === row.id)) yield* start(row.id, 'inspect')
    }
    yield* Effect.logInfo('Integration service ready').pipe(Effect.annotateLogs({ integrationCount: catalog.length }))
    return IntegrationService.of({ list, watch, install: (id) => start(id, 'install'), inspect: (id) => start(id, 'inspect'),
      action })
  }))
}
