import type {
  Api,
  AssistantMessage,
  Context,
  CredentialStore,
  FetchFunction,
  Model,
  ModelsRefreshOptions,
  ModelsRefreshResult,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { ModelRuntime, type CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";
import { Effect, Redacted, Schema } from "effect";
import type { AgentSettings, ModelProfile } from "../config/schema.js";
import { compileModelProfile, ModelConfigCompilerError } from "./model-config-compiler.js";

export const ModelRuntimeAdapterFailureReason = Schema.Literals([
  "configuration_invalid",
  "credential_missing",
  "model_unavailable",
  "catalog_unavailable",
  "provider_unavailable",
  "operation_aborted",
]);
export type ModelRuntimeAdapterFailureReason = typeof ModelRuntimeAdapterFailureReason.Type;

/** Stable runtime failure which deliberately excludes provider response bodies and underlying causes. */
export class ModelRuntimeAdapterError extends Schema.TaggedError<ModelRuntimeAdapterError>()(
  "ModelRuntimeAdapterError",
  {
    reason: ModelRuntimeAdapterFailureReason,
    message: Schema.String,
  },
) {}

const failureMessage: Record<ModelRuntimeAdapterFailureReason, string> = {
  configuration_invalid: "Model runtime configuration is invalid.",
  credential_missing: "Credential is not configured.",
  model_unavailable: "Configured model is not available.",
  catalog_unavailable: "Model catalog could not be refreshed.",
  provider_unavailable: "Model provider is unavailable.",
  operation_aborted: "Model operation was cancelled.",
};

const failure = (reason: ModelRuntimeAdapterFailureReason): ModelRuntimeAdapterError =>
  new ModelRuntimeAdapterError({ reason, message: failureMessage[reason] });

export interface ModelCatalogEntry {
  readonly providerId: string;
  readonly providerName: string;
  readonly modelId: string;
  readonly modelName: string;
  readonly api: string;
  readonly source: "builtin" | "custom";
  readonly reasoning: boolean;
  readonly input: readonly ("text" | "image")[];
  readonly contextWindow: number;
  readonly maxTokens: number;
}

export interface ModelCatalogSnapshot {
  readonly models: readonly ModelCatalogEntry[];
  readonly stale: boolean;
}

interface ModelRuntimePort {
  readonly getError: () => string | undefined;
  readonly getModels: (providerId?: string) => readonly Model<Api>[];
  readonly getModel: (providerId: string, modelId: string) => Model<Api> | undefined;
  readonly getProvider: (providerId: string) => { readonly name: string } | undefined;
  readonly refresh: (options?: ModelsRefreshOptions) => Promise<ModelsRefreshResult>;
  readonly completeSimple: (
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions,
  ) => Promise<AssistantMessage>;
}

type RuntimeFactory = (options: CreateModelRuntimeOptions) => Promise<ModelRuntimePort>;

export interface PiModelRuntimeAdapterOptions {
  readonly credentials: CredentialStore;
  readonly modelsPath: string;
  readonly modelsStorePath: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly connectionTimeoutMs?: number;
  /** Test seam around the public Pi runtime constructor, not a parallel runtime implementation. */
  readonly runtimeFactory?: RuntimeFactory;
  /** Test-only transport seam passed to Pi's provider request. */
  readonly requestFetch?: FetchFunction;
}

export interface PiModelRuntimeAdapter {
  readonly listCatalog: (
    settings: AgentSettings,
  ) => Effect.Effect<ModelCatalogSnapshot, ModelRuntimeAdapterError>;
  readonly refreshCatalog: (
    settings: AgentSettings,
  ) => Effect.Effect<ModelCatalogSnapshot, ModelRuntimeAdapterError>;
  readonly testConnection: (
    profile: ModelProfile,
  ) => Effect.Effect<void, ModelRuntimeAdapterError>;
}

const compilerFailure = (error: ModelConfigCompilerError): ModelRuntimeAdapterError => {
  if (error.reason === "credential_missing" || error.reason === "credential_store_unavailable") {
    return failure("credential_missing");
  }
  if (error.reason === "model_not_found" || error.reason === "builtin_provider_unknown") {
    return failure("model_unavailable");
  }
  return failure("configuration_invalid");
};

/**
 * Thin Electron-independent boundary around Pi's public ModelRuntime.
 * No model response body, provider error, request header or credential crosses this API.
 */
export const makePiModelRuntimeAdapter = (
  options: PiModelRuntimeAdapterOptions,
): PiModelRuntimeAdapter => {
  const runtimeFactory = options.runtimeFactory ?? ((input) => ModelRuntime.create(input));
  const runtimeOptions: CreateModelRuntimeOptions = {
    credentials: options.credentials,
    modelsPath: options.modelsPath,
    modelsStorePath: options.modelsStorePath,
    allowModelNetwork: false,
    refreshOnCreate: true,
  };

  const createRuntime = Effect.tryPromise({
    try: (signal) => runtimeFactory({ ...runtimeOptions, signal }),
    catch: () => failure("configuration_invalid"),
  }).pipe(Effect.flatMap((runtime) =>
    runtime.getError() === undefined
      ? Effect.succeed(runtime)
      : Effect.fail(failure("configuration_invalid"))));

  const toCatalog = (
    runtime: ModelRuntimePort,
    settings: AgentSettings,
    stale: boolean,
  ): ModelCatalogSnapshot => {
    const customProviders = new Set(settings.modelProfiles.flatMap((profile) =>
      profile.provider.type === "custom" ? [profile.provider.providerId] : []));
    const providers = new Map<string, string>();
    const models = runtime.getModels().map((model) => {
      const providerName = providers.get(model.provider) ?? runtime.getProvider(model.provider)?.name ?? model.provider;
      providers.set(model.provider, providerName);
      return {
        providerId: model.provider,
        providerName,
        modelId: model.id,
        modelName: model.name,
        api: model.api,
        source: customProviders.has(model.provider) ? "custom" : "builtin",
        reasoning: model.reasoning,
        input: [...model.input],
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      } satisfies ModelCatalogEntry;
    });
    models.sort((left, right) =>
      left.providerId.localeCompare(right.providerId) || left.modelId.localeCompare(right.modelId));
    return { models, stale };
  };

  const listCatalog = Effect.fn("PiModelRuntimeAdapter.listCatalog")(function*(settings: AgentSettings) {
    const runtime = yield* createRuntime;
    return toCatalog(runtime, settings, false);
  });

  const refreshCatalog = Effect.fn("PiModelRuntimeAdapter.refreshCatalog")(function*(settings: AgentSettings) {
    const runtime = yield* createRuntime;
    const result = yield* Effect.tryPromise({
      try: (signal) => runtime.refresh({ allowNetwork: true, force: true, signal }),
      catch: () => failure("catalog_unavailable"),
    });
    if (result.aborted) return yield* failure("operation_aborted");
    return toCatalog(runtime, settings, result.errors.size > 0);
  });

  const testConnection = Effect.fn("PiModelRuntimeAdapter.testConnection")(function*(profile: ModelProfile) {
    const compiled = yield* compileModelProfile(profile, {
      credentials: options.credentials,
      env: options.env,
    }).pipe(Effect.mapError(compilerFailure));
    const runtime = yield* createRuntime;
    const model = runtime.getModel(compiled.model.provider, compiled.model.id);
    if (model === undefined) return yield* failure("model_unavailable");
    const apiKey = compiled.credential.source === "environment"
      ? Redacted.value(compiled.credential.apiKey)
      : undefined;
    const response = yield* Effect.tryPromise({
      try: (signal) => runtime.completeSimple(model, {
        messages: [{ role: "user", content: "Reply with OK.", timestamp: 0 }],
      }, {
        signal,
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(options.requestFetch === undefined ? {} : { fetch: options.requestFetch }),
        maxTokens: 1,
        maxRetries: 0,
        timeoutMs: options.connectionTimeoutMs ?? 10_000,
      }),
      catch: () => failure("provider_unavailable"),
    });
    if (response.stopReason === "aborted") return yield* failure("operation_aborted");
    if (response.stopReason === "error") return yield* failure("provider_unavailable");
    return undefined;
  });

  return { listCatalog, refreshCatalog, testConnection };
};
