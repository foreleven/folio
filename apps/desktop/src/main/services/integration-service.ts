import { IntegrationContext, IntegrationError } from '@folio/integrations/base'
import type { Integration, IntegrationEffect, IngestContext } from '@folio/integrations/base'
import { Context, Effect, Fiber, FileSystem, Layer, Match, PubSub, Schema, Scope, Semaphore, Stream } from 'effect'
import { ChildProcessSpawner } from 'effect/unstable/process'
import { basename, delimiter, isAbsolute, join } from 'node:path'
import { IntegrationSettingsError, type IntegrationView } from '../../shared/integration'
import { IntegrationBrowser } from '../electron/IntegrationBrowser'
import { ConfigService } from './config-service'
import { IntegrationStore } from './integration-store'
import { IntegrationCatalog, type IntegrationPlatform } from './integration-catalog'
import { IntegrationAction } from '@folio/integrations/protocol'

const failure = () => new IntegrationSettingsError({ message: 'The integration operation failed. Check its status and try again.' })

/**
 * Turns an operation failure into a short, non-sensitive diagnostic for the
 * development terminal. Provider errors can carry request config and tokens,
 * so never log the full unknown value here.
 */
const operationErrorDetails = (cause: unknown): { name?: string; message: string; code?: string; status?: number } => {
  if (cause instanceof Error) {
    const value = cause as Error & { code?: unknown; response?: { status?: unknown } }
    return {
      name: cause.name,
      message: cause.message.slice(0, 500),
      ...(typeof value.code === 'string' ? { code: value.code.slice(0, 100) } : {}),
      ...(typeof value.response?.status === 'number' ? { status: value.response.status } : {})
    }
  }
  if (typeof cause === 'object' && cause !== null) {
    const value = cause as { message?: unknown; _tag?: unknown; code?: unknown; status?: unknown }
    return {
      ...(typeof value._tag === 'string' ? { name: value._tag.slice(0, 100) } : {}),
      message: (typeof value.message === 'string' ? value.message : 'Unknown integration failure').slice(0, 500),
      ...(typeof value.code === 'string' ? { code: value.code.slice(0, 100) } : {}),
      ...(typeof value.status === 'number' ? { status: value.status } : {})
    }
  }
  return { message: String(cause).slice(0, 500) }
}

/** Runtime-only paths and instructions. Credentials and opaque installation state never enter this result. */
export interface PreparedIntegrationResources {
  readonly skillPaths: readonly string[]
  readonly executableDirectories: readonly string[]
  readonly instructions: readonly string[]
  readonly workspaceFiles?: readonly { readonly path: string; readonly content: string }[]
  /** Ephemeral provider environment; never included in a Task resource snapshot. */
  readonly environment?: Readonly<Record<string, string>>
}

/** Owns process-lifetime jobs, SQLite state, and a push stream shared by all settings windows. */
export class IntegrationService extends Context.Service<IntegrationService, {
  readonly watch: Stream.Stream<readonly IntegrationView[], IntegrationSettingsError>
  readonly list: Effect.Effect<readonly IntegrationView[], IntegrationSettingsError>
  readonly install: (id: string) => Effect.Effect<void, IntegrationSettingsError>
  readonly inspect: (id: string) => Effect.Effect<void, IntegrationSettingsError>
  readonly action: (id: string, actionId: string, payload?: unknown) => Effect.Effect<void, IntegrationSettingsError>
  readonly prepare: (ids: readonly string[], workspaceDirectory: string, resourceIds?: readonly string[]) => Effect.Effect<PreparedIntegrationResources, IntegrationSettingsError>
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
    const setupFibers = new Map<string, Fiber.Fiber<void, never>>()
    const revisions = new Map<string, number>()
    const changes = yield* PubSub.unbounded<readonly IntegrationView[]>()
    yield* Effect.addFinalizer(() => PubSub.shutdown(changes))
    yield* Effect.addFinalizer(() => Effect.gen(function*() {
      const fibers = Array.from(setupFibers.values())
      if (!fibers.length) return
      yield* Effect.logInfo('Stopping integration provider setups').pipe(
        Effect.annotateLogs({ setupCount: fibers.length })
      )
      yield* Fiber.interruptAll(fibers)
      setupFibers.clear()
      yield* Effect.logInfo('Integration provider setups stopped').pipe(
        Effect.annotateLogs({ setupCount: fibers.length })
      )
    }))
    yield* Effect.logDebug('Integration service initialization started').pipe(
      Effect.annotateLogs({ integrationCount: catalog.length })
    )

    const list = Effect.gen(function*() {
      const rows = yield* store.list
      return catalog.map((integration) => ({
        id: integration.id, name: integration.name, actions: integration.actions, states: integration.states,
        description: integration.description, logo: integration.logo, homepage: integration.homepage,
        resources: integration.resources.map(({ id, type, name }) => ({ id, ...(type ? { type } : {}), name })),
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
      registerResource: ({ id: resourceId, type, name }) => commit(store.register(id, { id: resourceId, ...(type ? { type } : {}), name }).pipe(
        Effect.tap(() => Effect.logDebug('Integration resource registered').pipe(
          Effect.annotateLogs({ integration: id, resource: resourceId })
        ))
      )).pipe(Effect.mapError(() => new IntegrationError({ message: 'Could not register integration resource.' })))
    })
    /**
     * Rebinds installed resource IDs to trusted provider hooks and validates declared mounts.
     * This prepares a Session only: no installation, authorization action, Prompt, or ingestion.
     * The command gate excludes a new installation/action while preparing; existing jobs fail fast.
     */
    const prepare = Effect.fn('IntegrationService.prepare')(function*(ids: readonly string[], workspaceDirectory: string, resourceIds: readonly string[] = []) {
      if (!isAbsolute(workspaceDirectory)) return yield* failure()
      const requestedResources = new Set(resourceIds)
      if ([...requestedResources].some(resource => {
        const separator = resource.indexOf('/')
        return separator <= 0 || !new Set(ids).has(resource.slice(0, separator))
      })) return yield* failure()
      const rows = yield* store.list
      const skillPaths = new Set<string>()
      const executableDirectories = new Set<string>()
      const instructions = new Set<string>()
      const workspaceFiles = new Map<string, string>()
      const environment = new Map<string, string>()
      for (const id of new Set(ids)) {
        const integration = catalog.find(item => item.id === id)
        const installed = rows.find(row => row.id === id)
        if (!integration || !installed || running.has(id)
          || integration.states[installed.state]?.kind !== 'ready') return yield* failure()
        if (integration.resources.some(resource => !installed.resources.some(row => row.id === resource.id))) return yield* failure()
        // Readiness in SQLite can be stale; the provider owns the current executable/account check.
        yield* withContext(id, integration.check())
        const context: IngestContext = {
          integrationDirectory: join(config.directory, 'integrations', id), workspaceDirectory,
          skills: [], executableDirectories: [], instructions: [], workspaceFiles: [], env: {}
        }
        const selected = resourceIds.length ? installed.resources.filter(resource => requestedResources.has(`${id}/${resource.id}`)) : installed.resources
        if (resourceIds.length && selected.length === 0) return yield* failure()
        for (const resource of selected) {
          const implementation = integration.resources.find(item => item.id === resource.id)
          if (!implementation) return yield* failure()
          yield* implementation.onIngest(context)
        }
        // Environment credentials use a separate ephemeral channel; they are never
        // included in the asset manifest or persisted integration snapshot.
        for (const path of context.skills) {
          if (!isAbsolute(path) || basename(path) !== 'SKILL.md' || (yield* fs.stat(path)).type !== 'File') return yield* failure()
          skillPaths.add(path)
        }
        for (const path of context.executableDirectories) {
          if (!isAbsolute(path) || path.includes(delimiter) || (yield* fs.stat(path)).type !== 'Directory') return yield* failure()
          executableDirectories.add(path)
        }
        for (const instruction of context.instructions) instructions.add(instruction)
        for (const file of context.workspaceFiles ?? []) workspaceFiles.set(file.path, file.content)
        for (const [key, value] of Object.entries(context.env)) {
          if (!/^[A-Z][A-Z0-9_]*$/.test(key)
            || ['PATH', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES'].includes(key)
            || key.startsWith('FOLIO_')) return yield* failure()
          const previous = environment.get(key)
          if (previous !== undefined && previous !== value) return yield* failure()
          environment.set(key, value)
        }
      }
      const files = [...workspaceFiles].map(([path, content]) => ({ path, content }))
      const env = Object.fromEntries(environment)
      return { skillPaths: [...skillPaths], executableDirectories: [...executableDirectories], instructions: [...instructions],
        ...(files.length ? { workspaceFiles: files } : {}), ...(Object.keys(env).length ? { environment: env } : {}) }
    }, commands.withPermit, Effect.mapError(failure))
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
    /** Keeps a healthy ready snapshot; all other states and failed health checks require full reconciliation. */
    const check = Effect.fn('IntegrationService.check')(function*(integration: Integration<IntegrationPlatform>) {
      const row = (yield* store.list).find((row) => row.id === integration.id)!
      if (row.state !== 'ready') return yield* reconcile(integration)
      const healthy = yield* withContext(integration.id, integration.check()).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.logWarning('Integration health check failed').pipe(
          Effect.annotateLogs({ integration: integration.id }),
          Effect.as(false)
        ))
      )
      if (!healthy) return yield* reconcile(integration)
      yield* Effect.logDebug('Integration health check completed').pipe(
        Effect.annotateLogs({ integration: integration.id })
      )
    }, Effect.annotateLogs({ subsystem: 'integration-orchestration' }), Effect.withLogSpan('integration.check'))
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
      if (integration.setup && !setupFibers.has(id)) {
        yield* Effect.logInfo('Integration provider setup started').pipe(Effect.annotateLogs({ integration: id }))
        // Provider setup outlives the requesting RPC and is interrupted by the service finalizer before process exit.
        const fiber = yield* withContext(id, integration.setup()).pipe(
          Effect.tapError(() => Effect.logError('Integration provider setup failed').pipe(
            Effect.annotateLogs({ integration: id })
          )),
          Effect.catch(() => commit(store.update(id, 'check_failed', {}, [], 'The connection could not be maintained. Check its status.'))),
          Effect.ensuring(Effect.sync(() => setupFibers.delete(id))),
          Effect.ensuring(Effect.logInfo('Integration provider setup stopped').pipe(Effect.annotateLogs({ integration: id }))),
          Effect.catch(() => Effect.void), Effect.interruptible,
          Effect.forkDetach({ startImmediately: false })
        )
        setupFibers.set(id, fiber)
      }
      running.add(id)
      yield* Effect.logInfo('Integration operation scheduled').pipe(
        Effect.annotateLogs({ integration: id, operation, action: actionId ?? 'none' })
      )
      const job = Effect.gen(function*() {
        yield* Effect.logInfo('Integration operation started').pipe(
          Effect.annotateLogs({ integration: id, operation, action: actionId ?? 'none' })
        )
        if (operation !== 'inspect' || row?.state !== 'ready') yield* commit(store.update(id, 'checking', {}, []))
        if (operation === 'install') {
          // Even shared, already-ready tools must register their resources with this host.
          yield* withContext(id, integration.install())
        } else if (operation === 'action') {
          const checked = yield* withContext(id, integration.inspect())
          if (!checked.actions.some((action) => action.id === actionId && action.type === 'callback')) return yield* new IntegrationSettingsError({ message: 'This action is no longer available. Check again.' })
          yield* withContext(id, integration.onActionCallback(actionId!, payload))
        } else {
          yield* check(integration)
          yield* Effect.logInfo('Integration operation completed').pipe(
            Effect.annotateLogs({ integration: id, operation, action: actionId ?? 'none' })
          )
          return
        }
        yield* reconcile(integration)
        yield* Effect.logInfo('Integration operation completed').pipe(
          Effect.annotateLogs({ integration: id, operation, action: actionId ?? 'none' })
        )
      }).pipe(
        Effect.catch((cause) => Effect.gen(function*() {
          // The durable state intentionally exposes only a generic failure to
          // the renderer. Keep the actionable cause in the terminal instead,
          // while avoiding the full provider error object (which may contain
          // OAuth credentials in request config).
          console.error('[Folio][Integration] operation failed', {
            integration: id,
            operation,
            action: actionId ?? 'none',
            error: operationErrorDetails(cause)
          })
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
      yield* Match.value(selected).pipe(
        Match.when({ type: 'callback' }, () => Effect.gen(function*() {
          // Validate declared inputs before acknowledging the job; never persist submitted values.
          const definition = integration.actions.find((item) => item.id === actionId)!
          if (definition.fields?.length) {
            const values = yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.String))(payload)
            if (definition.fields.some((field) => field.required && !values[field.id]?.trim())) {
              return yield* new IntegrationSettingsError({ message: 'Complete the required fields.' })
            }
          }
          yield* start(id, 'action', actionId, payload)
        })),
        Match.when({ type: 'open-url' }, ({ url: target }) => Effect.gen(function*() {
          // Providers own domain policy. The host supports HTTPS navigation, never arbitrary OS schemes.
          const url = yield* Effect.try(() => new URL(target))
          if (url.protocol !== 'https:' || url.username || url.password) return yield* failure()
          yield* Effect.logInfo('Opening integration authorization page').pipe(
            Effect.annotateLogs({ integration: id, action: actionId })
          )
          yield* browser.open(url.toString())
        })),
        Match.exhaustive
      )
    }, Effect.mapError(failure))

    // Reconcile only installed rows on application restart; merely browsing never inserts rows.
    for (const row of yield* store.list) {
      if (catalog.some((item) => item.id === row.id)) yield* start(row.id, 'inspect')
    }
    yield* Effect.logInfo('Integration service ready').pipe(Effect.annotateLogs({ integrationCount: catalog.length }))
    return IntegrationService.of({ list, watch, install: (id) => start(id, 'install'), inspect: (id) => start(id, 'inspect'),
      action, prepare })
  }))
}
