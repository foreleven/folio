import {
  compileDerivedPiModelConfig,
  compileModelProfile,
  makePiModelRuntimeAdapter,
  type ModelRuntimeAdapterError,
  serializeDerivedPiModelConfig,
  SecureCredentialStore,
  type PiModelRuntimeAdapter
} from '@folio/agent/model'
import { resolveFolioAgentDirectory } from '@folio/agent/config/directory'
import { AgentSettings, ModelProfile } from '@folio/agent/config/schema'
import { Context, Effect, FileSystem, Layer, Path, PubSub, Redacted, Ref, Schema, Semaphore, Stream } from 'effect'
import {
  SessionModelSelection,
  type ModelCatalogView,
  ModelServiceError,
  type ModelServiceFailureReason,
  type ModelSettingsView
} from '../../shared/model'
import { ConfigService } from './config-service'

const failureMessage: Record<ModelServiceFailureReason, string> = {
  invalid_profile: 'The model profile is invalid.',
  profile_not_found: 'The model profile was not found.',
  default_profile_delete: 'Choose a different default model before deleting this profile.',
  config_unavailable: 'Model settings are unavailable.',
  credential_unavailable: 'Model credentials are unavailable.',
  credential_shared: 'This credential is shared by another model profile.',
  derived_config_unavailable: 'The generated model configuration could not be updated.',
  catalog_unavailable: 'The model catalog is unavailable.',
  provider_unavailable: 'The model provider is unavailable.',
  operation_aborted: 'The model operation was cancelled.'
}

const failure = (reason: ModelServiceFailureReason) => new ModelServiceError({
  reason,
  message: failureMessage[reason]
})

const runtimeFailure = (error: ModelRuntimeAdapterError): ModelServiceError => {
  switch (error.reason) {
    case 'credential_missing': return failure('credential_unavailable')
    case 'catalog_unavailable': return failure('catalog_unavailable')
    case 'provider_unavailable': return failure('provider_unavailable')
    case 'operation_aborted': return failure('operation_aborted')
    case 'configuration_invalid':
    case 'model_unavailable':
      return failure('invalid_profile')
  }
}

export interface ModelServiceOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly runtimeAdapter?: PiModelRuntimeAdapter
}

/** Owns main-process model commands; all externally visible state is credential-blind. */
export class ModelService extends Context.Service<ModelService, {
  readonly resolveSessionModel: (selection: SessionModelSelection) => Effect.Effect<ModelProfile, ModelServiceError>
  readonly directory: string
  readonly setProviderCredential: (providerId: string, apiKey: Redacted.Redacted<string>) => Effect.Effect<ModelSettingsView, ModelServiceError>
  readonly modelsPath: string
  readonly list: Effect.Effect<ModelSettingsView, ModelServiceError>
  readonly watch: Stream.Stream<ModelSettingsView, ModelServiceError>
  readonly listCatalog: Effect.Effect<ModelCatalogView, ModelServiceError>
  readonly refreshCatalog: Effect.Effect<ModelCatalogView, ModelServiceError>
  readonly testConnection: (profileId: string) => Effect.Effect<ModelSettingsView, ModelServiceError>
  readonly saveProfile: (profile: ModelProfile) => Effect.Effect<ModelSettingsView, ModelServiceError>
  readonly deleteProfile: (profileId: string) => Effect.Effect<ModelSettingsView, ModelServiceError>
  readonly setDefault: (profileId: string | undefined) => Effect.Effect<ModelSettingsView, ModelServiceError>
  readonly setCredential: (
    profileId: string,
    apiKey: Redacted.Redacted<string>
  ) => Effect.Effect<ModelSettingsView, ModelServiceError>
  readonly deleteCredential: (profileId: string) => Effect.Effect<ModelSettingsView, ModelServiceError>
  readonly rebuildDerivedConfig: Effect.Effect<void, ModelServiceError>
}>()('folio/services/ModelService') {
  static layer(options: ModelServiceOptions = {}) {
    return Layer.effect(ModelService, Effect.gen(function*() {
      const config = yield* ConfigService
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const commands = yield* Semaphore.make(1)
      const changes = yield* PubSub.unbounded<ModelSettingsView>()
      yield* Effect.addFinalizer(() => PubSub.shutdown(changes))

      const environment = options.environment ?? process.env
      const directory = resolveFolioAgentDirectory({
        env: {
          FOLIO_CONFIG_DIR: config.directory,
          FOLIO_AGENT_DIR: environment.FOLIO_AGENT_DIR
        }
      })
      const modelsPath = path.join(directory, 'models.generated.json')
      const modelsStorePath = path.join(directory, 'models-store.json')
      const credentials = new SecureCredentialStore({ authPath: path.join(directory, 'auth.json') })
      // Import only in main, keeping raw Pi credentials out of config.watch and renderer state.
      const homeDirectory = environment.HOME
      const piImportFailed = homeDirectory === undefined ? false : yield* Effect.gen(function*() {
        // Pi stores auth under ~/.pi/agent. Retain the originally requested shorter path as fallback.
        const standardPath = path.join(homeDirectory, '.pi', 'agent', 'auth.json')
        const sourcePath = (yield* fs.exists(standardPath))
          ? standardPath
          : path.join(homeDirectory, '.pi', 'auth.json')
        yield* Effect.tryPromise({
          try: () => credentials.importPiAuth(sourcePath),
          catch: () => failure('credential_unavailable')
        })
      }).pipe(Effect.as(false), Effect.catch(() => Effect.succeed(true)))
      const runtime = options.runtimeAdapter ?? makePiModelRuntimeAdapter({
        credentials,
        modelsPath,
        modelsStorePath,
        env: environment
      })
      const connectionStatuses = yield* Ref.make(new Map<string, 'ready' | 'unavailable'>())

      const getSettings = config.get.pipe(
        Effect.map(({ agent }) => agent),
        Effect.mapError(() => failure('config_unavailable'))
      )

      const credentialProviders = Effect.tryPromise({
        try: () => credentials.list(),
        catch: () => failure('credential_unavailable')
      }).pipe(Effect.map((entries) => new Set(entries.map(({ providerId }) => providerId))))

      const toView = Effect.fn('ModelService.toView')(function*(settings: AgentSettings) {
        const providers = yield* credentialProviders
        const statuses = yield* Ref.get(connectionStatuses)
        return {
          enabled: settings.enabled,
          configuredProviders: [...providers],
          piImportFailed,
          ...(settings.defaultModelProfileId === undefined
            ? {}
            : { defaultModelProfileId: settings.defaultModelProfileId }),
          profiles: settings.modelProfiles.map((profile) => ({
            profile,
            credentialConfigured: profile.credentialSource === 'none' ||
              (profile.credentialSource === 'managed'
                ? providers.has(profile.provider.providerId)
                : Boolean(profile.environmentVariable && environment[profile.environmentVariable])),
            connectionStatus: statuses.get(profile.id) ?? 'untested'
          }))
        } satisfies ModelSettingsView
      })

      const list = Effect.flatMap(getSettings, toView)

      const publishCurrent = list.pipe(
        Effect.flatMap((view) => PubSub.publish(changes, view)),
        Effect.catch(() => Effect.void)
      )

      const watch = Stream.unwrap(Effect.gen(function*() {
        const { subscription, initial } = yield* Effect.gen(function*() {
          const subscription = yield* PubSub.subscribe(changes)
          return { subscription, initial: yield* list }
        }).pipe(commands.withPermit)
        return Stream.concat(Stream.succeed(initial), Stream.fromSubscription(subscription))
      }))

      const writeDerived = Effect.fn('ModelService.writeDerived')(function*(settings: AgentSettings) {
        const derived = yield* compileDerivedPiModelConfig(settings).pipe(
          Effect.mapError(() => failure('invalid_profile'))
        )
        yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
        yield* fs.chmod(directory, 0o700)
        const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
          directory,
          prefix: '.models-'
        })
        const temporaryFile = path.join(temporaryDirectory, 'models.generated.json')
        yield* fs.writeFileString(temporaryFile, serializeDerivedPiModelConfig(derived), { mode: 0o600 })
        yield* fs.rename(temporaryFile, modelsPath).pipe(
          Effect.andThen(fs.chmod(modelsPath, 0o600)),
          Effect.uninterruptible
        )
      }, Effect.scoped, Effect.mapError(() => failure('derived_config_unavailable')))

      const persist = Effect.fn('ModelService.persist')(function*(settings: AgentSettings) {
        // Compile before changing the source of truth; filesystem replacement follows the committed config.
        yield* compileDerivedPiModelConfig(settings).pipe(Effect.mapError(() => failure('invalid_profile')))
        const stored = yield* config.setAgent(settings).pipe(
          Effect.mapError(() => failure('config_unavailable'))
        )
        yield* writeDerived(stored.agent)
        const ids = new Set(stored.agent.modelProfiles.map(({ id }) => id))
        yield* Ref.update(connectionStatuses, (statuses) => new Map(
          [...statuses].filter(([id]) => ids.has(id))
        ))
        return yield* toView(stored.agent)
      })

      const announce = <A>(operation: Effect.Effect<A, ModelServiceError>) => operation.pipe(
        Effect.tap(() => publishCurrent),
        Effect.tapError(() => publishCurrent)
      )

      const resetConnection = (profileId: string) => Ref.update(
        connectionStatuses,
        (statuses) => {
          const next = new Map(statuses)
          next.delete(profileId)
          return next
        }
      )

      /** A managed credential belongs to its provider, so every dependent test result expires together. */
      const resetProviderConnections = (settings: AgentSettings, providerId: string) => Ref.update(
        connectionStatuses,
        (statuses) => {
          const next = new Map(statuses)
          for (const profile of settings.modelProfiles) {
            if (profile.credentialSource === 'managed' && profile.provider.providerId === providerId) next.delete(profile.id)
          }
          return next
        }
      )

      const saveProfile = Effect.fn('ModelService.saveProfile')(function*(input: ModelProfile) {
        const profile = yield* Schema.decodeUnknownEffect(ModelProfile)(input, {
          onExcessProperty: 'error',
          errors: 'all'
        }).pipe(Effect.mapError(() => failure('invalid_profile')))
        const current = yield* getSettings
        const index = current.modelProfiles.findIndex(({ id }) => id === profile.id)
        const profiles = [...current.modelProfiles]
        if (index === -1) profiles.push(profile)
        else profiles[index] = profile
        yield* persist({ ...current, modelProfiles: profiles })
        yield* resetConnection(profile.id)
        return yield* list
      }, commands.withPermit, announce)

      const deleteProfile = Effect.fn('ModelService.deleteProfile')(function*(profileId: string) {
        const current = yield* getSettings
        if (!current.modelProfiles.some(({ id }) => id === profileId)) {
          return yield* failure('profile_not_found')
        }
        if (current.defaultModelProfileId === profileId) {
          return yield* failure('default_profile_delete')
        }
        return yield* persist({
          ...current,
          modelProfiles: current.modelProfiles.filter(({ id }) => id !== profileId)
        })
      }, commands.withPermit, announce)

      const setDefault = Effect.fn('ModelService.setDefault')(function*(profileId: string | undefined) {
        const current = yield* getSettings
        if (profileId !== undefined && !current.modelProfiles.some(({ id }) => id === profileId)) {
          return yield* failure('profile_not_found')
        }
        const { defaultModelProfileId: _previousDefault, ...withoutDefault } = current
        return yield* persist(profileId === undefined
          ? withoutDefault
          : { ...withoutDefault, defaultModelProfileId: profileId })
      }, commands.withPermit, announce)

      const findProfile = Effect.fn('ModelService.findProfile')(function*(profileId: string) {
        const settings = yield* getSettings
        const profile = settings.modelProfiles.find(({ id }) => id === profileId)
        if (profile === undefined) return yield* failure('profile_not_found')
        return profile
      })

      const setCredential = Effect.fn('ModelService.setCredential')(function*(
        profileId: string,
        apiKey: Redacted.Redacted<string>
      ) {
        const profile = yield* findProfile(profileId)
        if (profile.credentialSource !== 'managed') return yield* failure('invalid_profile')
        const value = Redacted.value(apiKey)
        if (value.length === 0) return yield* failure('credential_unavailable')
        yield* Effect.tryPromise({
          try: () => credentials.modify(profile.provider.providerId, async () => ({ type: 'api_key', key: value })),
          catch: () => failure('credential_unavailable')
        })
        yield* resetProviderConnections(yield* getSettings, profile.provider.providerId)
        return yield* list
      }, commands.withPermit, announce)

      /** Saves a catalog provider's credential independently of model selection; updates all shared profile statuses. */
      const setProviderCredential = Effect.fn('ModelService.setProviderCredential')(function*(
        providerId: string,
        apiKey: Redacted.Redacted<string>
      ) {
        const settings = yield* getSettings
        const catalog = yield* runtime.listCatalog(settings).pipe(Effect.mapError(runtimeFailure))
        if (!catalog.models.some((model) => model.providerId === providerId)) return yield* failure('provider_unavailable')
        const key = Redacted.value(apiKey).trim()
        if (key.length === 0) return yield* failure('credential_unavailable')
        yield* Effect.tryPromise({
          try: () => credentials.modify(providerId, async () => ({ type: 'api_key', key })),
          catch: () => failure('credential_unavailable')
        })
        yield* resetProviderConnections(settings, providerId)
        return yield* list
      }, commands.withPermit, announce)

      const deleteCredential = Effect.fn('ModelService.deleteCredential')(function*(profileId: string) {
        const settings = yield* getSettings
        const profile = settings.modelProfiles.find(({ id }) => id === profileId)
        if (profile === undefined) return yield* failure('profile_not_found')
        if (profile.credentialSource !== 'managed') return yield* failure('invalid_profile')
        if (settings.modelProfiles.some((candidate) =>
          candidate.id !== profile.id &&
          candidate.credentialSource === 'managed' &&
          candidate.provider.providerId === profile.provider.providerId
        )) return yield* failure('credential_shared')
        yield* Effect.tryPromise({
          try: () => credentials.delete(profile.provider.providerId),
          catch: () => failure('credential_unavailable')
        })
        yield* resetConnection(profile.id)
        return yield* list
      }, commands.withPermit, announce)

      const listCatalog = Effect.flatMap(getSettings, (settings) => runtime.listCatalog(settings).pipe(
        Effect.mapError(runtimeFailure)
      )).pipe(commands.withPermit)

      /** Resolves Provider-only UI choices without mutating global defaults or making a model request. */
      const resolveSessionModel = Effect.fn('ModelService.resolveSessionModel')(function*(input: SessionModelSelection) {
        const choice = yield* Schema.decodeUnknownEffect(SessionModelSelection)(input, { onExcessProperty: 'error' }).pipe(
          Effect.mapError(() => failure('invalid_profile')))
        const settings = yield* getSettings
        const catalog = yield* runtime.listCatalog(settings).pipe(Effect.mapError(runtimeFailure))
        const entry = catalog.models.find(model => model.providerId === choice.providerId && model.modelId === choice.modelId)
        if (!entry || entry.source !== 'builtin') return yield* failure('invalid_profile')
        const profile: ModelProfile = {
          id: 'session-model', name: entry.modelName,
          provider: { type: 'builtin', providerId: choice.providerId }, modelId: choice.modelId,
          thinkingLevel: choice.thinkingLevel, credentialSource: 'managed'
        }
        yield* compileModelProfile(profile, { credentials, env: environment }).pipe(
          Effect.mapError(error => failure(error.reason === 'credential_missing' || error.reason === 'credential_store_unavailable'
            ? 'credential_unavailable' : 'invalid_profile')))
        return profile
      }, commands.withPermit)

      const refreshCatalog = Effect.flatMap(getSettings, (settings) => runtime.refreshCatalog(settings).pipe(
        Effect.mapError(runtimeFailure)
      )).pipe(commands.withPermit)

      const setConnectionStatus = (profileId: string, status: 'ready' | 'unavailable') => Ref.update(
        connectionStatuses,
        (statuses) => new Map(statuses).set(profileId, status)
      )

      const testConnection = Effect.fn('ModelService.testConnection')(function*(profileId: string) {
        const profile = yield* findProfile(profileId)
        yield* runtime.testConnection(profile).pipe(
          Effect.mapError(runtimeFailure),
          Effect.tap(() => setConnectionStatus(profileId, 'ready')),
          Effect.tapError(() => setConnectionStatus(profileId, 'unavailable'))
        )
        return yield* list
      }, commands.withPermit, announce)

      const rebuildDerivedConfig = Effect.flatMap(getSettings, writeDerived).pipe(commands.withPermit)

      return ModelService.of({
        resolveSessionModel,
        setProviderCredential,
        directory,
        modelsPath,
        list,
        watch,
        listCatalog,
        refreshCatalog,
        testConnection,
        saveProfile,
        deleteProfile,
        setDefault,
        setCredential,
        deleteCredential,
        rebuildDerivedConfig
      })
    }))
  }
}
