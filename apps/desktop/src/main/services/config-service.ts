import {
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  PubSub,
  Schema,
  Semaphore,
  Stream
} from 'effect'
import { homedir } from 'node:os'
import { ConfigStoreError, GlobalConfig, GlobalConfigPatch } from '../../shared/config'

const ConfigJson = Schema.fromJsonString(GlobalConfig, { space: 2 })

/** Main-process owner of global preferences, shared through the application Layer. */
export class ConfigService extends Context.Service<
  ConfigService,
  {
    readonly directory: string
    readonly filePath: string
    /** Reads current disk values, defaulting only absent files/fields; never writes. */
    readonly get: Effect.Effect<GlobalConfig, ConfigStoreError>
    /** Emits a disk snapshot followed by changes committed through this service. */
    readonly watch: Stream.Stream<GlobalConfig, ConfigStoreError>
    /** Validates and merges a patch, then atomically persists and returns the result. */
    readonly update: (patch: GlobalConfigPatch) => Effect.Effect<GlobalConfig, ConfigStoreError>
  }
>()('folio/services/ConfigService') {
  /** Resolves the directory once per layer; filesystem access starts on get/update. */
  static readonly layer = Layer.effect(
    ConfigService,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* Effect.sync(homedir)
      const configuredDirectory = yield* Config.nonEmptyString('FOLIO_CONFIG_DIR').pipe(
        Config.withDefault(path.join(home, '.folio'))
      )
      const directory = path.resolve(configuredDirectory)
      const filePath = path.join(directory, 'config.json')
      const lock = yield* Semaphore.make(1)
      const changes = yield* PubSub.unbounded<GlobalConfig>()
      yield* Effect.addFinalizer(() => PubSub.shutdown(changes))

      // Only absence uses defaults: damaged files and permission errors must remain visible.
      const read = fs.readFileString(filePath).pipe(
        Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed('{}')),
        Effect.flatMap(Schema.decodeUnknownEffect(ConfigJson))
      )

      const get = read.pipe(
        Effect.mapError((cause) => new ConfigStoreError({ path: filePath, operation: 'read', cause }))
      )

      // Subscribe and read under the write lock so an update cannot fall between
      // the initial snapshot and subscription, or deliver older queued values.
      const watch = Stream.unwrap(Effect.gen(function*() {
        const { subscription, initial } = yield* Effect.gen(function*() {
          const subscription = yield* PubSub.subscribe(changes)
          const initial = yield* get
          return { subscription, initial }
        }).pipe(lock.withPermit)
        return Stream.concat(Stream.succeed(initial), Stream.fromSubscription(subscription))
      }))

      /** Serializes read/merge/write within this service; failed writes preserve the old file. */
      const update = Effect.fn('ConfigService.update')(
        function*(patch: GlobalConfigPatch) {
          const validated = yield* Schema.decodeUnknownEffect(GlobalConfigPatch)(patch, {
            onExcessProperty: 'error'
          })
          const current = yield* read
          const next = { ...current, ...validated }
          const json = yield* Schema.encodeEffect(ConfigJson)(next)
          yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })

          // A sibling temporary directory keeps rename on the same filesystem and
          // scoped cleanup removes temporary data on failure or interruption.
          const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
            directory,
            prefix: '.config-'
          })
          const temporaryFile = path.join(temporaryDirectory, 'config.json')
          yield* fs.writeFileString(temporaryFile, `${json}\n`, { mode: 0o600 })
          // Once replacement starts, publish the committed value even if the
          // requesting window closes; other windows must observe persisted state.
          yield* fs.rename(temporaryFile, filePath).pipe(
            Effect.andThen(PubSub.publish(changes, next)),
            Effect.uninterruptible
          )
          return next
        },
        Effect.scoped,
        lock.withPermit,
        Effect.mapError((cause) => new ConfigStoreError({ path: filePath, operation: 'update', cause }))
      )

      return ConfigService.of({ directory, filePath, get, watch, update })
    })
  )
}
