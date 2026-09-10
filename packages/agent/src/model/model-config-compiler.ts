import { createHash } from "node:crypto";
import type { CredentialStore, Api, Model } from "@earendil-works/pi-ai";
import {
  getBuiltinModels,
  getBuiltinProviders,
  type BuiltinProvider as PiBuiltinProvider,
} from "@earendil-works/pi-ai/providers/all";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Effect, Redacted, Schema } from "effect";
import type { AgentSettings, ModelProfile, ThinkingLevel } from "../config/schema.js";

export const ModelConfigCompilerFailureReason = Schema.Literals([
  "agent_disabled",
  "default_profile_missing",
  "profile_not_found",
  "builtin_provider_unknown",
  "model_not_found",
  "model_metadata_missing",
  "provider_conflict",
  "credential_missing",
  "credential_store_unavailable",
]);
export type ModelConfigCompilerFailureReason = typeof ModelConfigCompilerFailureReason.Type;

/** Stable, serializable compiler failure. It deliberately carries no source value or cause. */
export class ModelConfigCompilerError extends Schema.TaggedError<ModelConfigCompilerError>()(
  "ModelConfigCompilerError",
  {
    reason: ModelConfigCompilerFailureReason,
    message: Schema.String,
  },
) {}

const failureMessage: Record<ModelConfigCompilerFailureReason, string> = {
  agent_disabled: "Agent capability is disabled.",
  default_profile_missing: "Default model profile is not configured.",
  profile_not_found: "Model profile was not found.",
  builtin_provider_unknown: "Built-in model provider is not available.",
  model_not_found: "Configured model is not available.",
  model_metadata_missing: "Custom model metadata is required.",
  provider_conflict: "Custom provider configuration conflicts across profiles.",
  credential_missing: "Credential is not configured.",
  credential_store_unavailable: "Credential storage is unavailable.",
};

const compilerError = (reason: ModelConfigCompilerFailureReason): ModelConfigCompilerError =>
  new ModelConfigCompilerError({ reason, message: failureMessage[reason] });

type PiProviderConfig = Parameters<ModelRuntime["registerProvider"]>[1];

export interface PiProviderRegistration {
  readonly providerId: string;
  readonly config: PiProviderConfig;
}

export type ResolvedModelCredential =
  | { readonly source: "managed" }
  | { readonly source: "environment"; readonly apiKey: Redacted.Redacted<string> }
  | { readonly source: "none" };

export interface CompiledModelProfile {
  readonly profileId: string;
  readonly model: Model<Api>;
  readonly thinkingLevel: ThinkingLevel;
  readonly credential: ResolvedModelCredential;
  readonly providerRegistration?: PiProviderRegistration;
}

export interface ModelConfigCompilerOptions {
  readonly credentials?: CredentialStore;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface DerivedPiModelDefinition {
  readonly id: string;
  readonly name: string;
  readonly api: "openai-completions" | "anthropic-messages";
  readonly baseUrl: string;
  readonly reasoning: boolean;
  readonly input: readonly ["text"];
  readonly cost: {
    readonly input: 0;
    readonly output: 0;
    readonly cacheRead: 0;
    readonly cacheWrite: 0;
  };
  readonly contextWindow: number;
  readonly maxTokens: number;
}

export interface DerivedPiProviderConfig {
  readonly name: string;
  readonly baseUrl: string;
  readonly api: "openai-completions" | "anthropic-messages";
  readonly models: readonly DerivedPiModelDefinition[];
}

/** Credential-blind, rebuildable Pi model configuration derived from AgentSettings. */
export interface DerivedPiModelConfig {
  readonly version: 1;
  readonly sourceChecksum: string;
  readonly providers: Readonly<Record<string, DerivedPiProviderConfig>>;
}

const zeroCost = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const);

const findBuiltinModel = (providerId: string, modelId: string): Model<Api> => {
  const providers = getBuiltinProviders() as readonly string[];
  if (!providers.includes(providerId)) throw compilerError("builtin_provider_unknown");
  const models = getBuiltinModels(providerId as PiBuiltinProvider) as readonly Model<Api>[];
  const model = models.find(({ id }) => id === modelId);
  if (model === undefined) throw compilerError("model_not_found");
  return model;
};

const customModelDefinition = (profile: ModelProfile): DerivedPiModelDefinition => {
  if (profile.provider.type !== "custom") throw compilerError("model_metadata_missing");
  const metadata = profile.customModel;
  if (metadata === undefined) throw compilerError("model_metadata_missing");
  return {
    id: profile.modelId,
    name: metadata.displayName,
    api: profile.provider.api,
    baseUrl: profile.provider.baseUrl,
    reasoning: metadata.reasoning,
    input: ["text"],
    cost: zeroCost(),
    contextWindow: metadata.contextWindow,
    maxTokens: metadata.maxTokens,
  };
};

const compileModel = (profile: ModelProfile): {
  readonly model: Model<Api>;
  readonly providerRegistration?: PiProviderRegistration;
} => {
  if (profile.provider.type === "builtin") {
    return { model: findBuiltinModel(profile.provider.providerId, profile.modelId) };
  }
  const definition = customModelDefinition(profile);
  const model: Model<Api> = {
    ...definition,
    provider: profile.provider.providerId,
    input: [...definition.input],
    cost: { ...definition.cost },
  };
  return {
    model,
    providerRegistration: {
      providerId: profile.provider.providerId,
      config: {
        name: profile.provider.providerId,
        baseUrl: profile.provider.baseUrl,
        api: profile.provider.api,
        models: [{
          ...definition,
          input: [...definition.input],
          cost: { ...definition.cost },
        }],
      },
    },
  };
};

const resolveCredential = (
  profile: ModelProfile,
  options: ModelConfigCompilerOptions,
): Effect.Effect<ResolvedModelCredential, ModelConfigCompilerError> => {
  if (profile.credentialSource === "none") return Effect.succeed({ source: "none" });
  if (profile.credentialSource === "environment") {
    const name = profile.environmentVariable;
    const value = name === undefined ? undefined : (options.env ?? process.env)[name];
    if (value === undefined || value.length === 0) return Effect.fail(compilerError("credential_missing"));
    return Effect.succeed({ source: "environment", apiKey: Redacted.make(value) });
  }
  if (options.credentials === undefined) return Effect.fail(compilerError("credential_store_unavailable"));
  return Effect.tryPromise({
    try: () => options.credentials!.read(profile.provider.providerId),
    catch: () => compilerError("credential_store_unavailable"),
  }).pipe(
    Effect.flatMap((credential) =>
      credential === undefined
        ? Effect.fail(compilerError("credential_missing"))
        : Effect.succeed({ source: "managed" } as const)),
  );
};

export const compileModelProfile = Effect.fn("ModelConfigCompiler.compileModelProfile")(
  function*(profile: ModelProfile, options: ModelConfigCompilerOptions = {}) {
    const compiled = yield* Effect.try({
      try: () => compileModel(profile),
      catch: (error) => error instanceof ModelConfigCompilerError
        ? error
        : compilerError("model_not_found"),
    });
    const credential = yield* resolveCredential(profile, options);
    return {
      profileId: profile.id,
      model: compiled.model,
      thinkingLevel: profile.thinkingLevel,
      credential,
      ...(compiled.providerRegistration === undefined
        ? {}
        : { providerRegistration: compiled.providerRegistration }),
    } satisfies CompiledModelProfile;
  },
);

export const compileDefaultModelProfile = Effect.fn("ModelConfigCompiler.compileDefaultModelProfile")(
  function*(settings: AgentSettings, options: ModelConfigCompilerOptions = {}) {
    if (!settings.enabled) return yield* compilerError("agent_disabled");
    if (settings.defaultModelProfileId === undefined) return yield* compilerError("default_profile_missing");
    const profile = settings.modelProfiles.find(({ id }) => id === settings.defaultModelProfileId);
    if (profile === undefined) return yield* compilerError("profile_not_found");
    return yield* compileModelProfile(profile, options);
  },
);

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
};

const sourceChecksum = (settings: AgentSettings): string =>
  createHash("sha256").update(JSON.stringify(canonicalize(settings))).digest("hex");

/**
 * Serialize the generated artifact in Pi's credential-blind models.json shape.
 * The checksum lives in a JSON comment because Pi strips comments before strict schema validation.
 */
export const serializeDerivedPiModelConfig = (config: DerivedPiModelConfig): string => {
  const body = JSON.stringify(canonicalize({ providers: config.providers }), null, 2);
  return [
    "// Generated by Folio. Do not edit; config.json is the source of truth.",
    `// sourceChecksum: sha256:${config.sourceChecksum}`,
    body,
    "",
  ].join("\n");
};

const sameProvider = (left: DerivedPiProviderConfig, right: DerivedPiProviderConfig): boolean =>
  left.baseUrl === right.baseUrl && left.api === right.api && left.name === right.name;

/** Compile the credential-blind, deterministic models.generated.json snapshot. */
export const compileDerivedPiModelConfig = (
  settings: AgentSettings,
): Effect.Effect<DerivedPiModelConfig, ModelConfigCompilerError> => Effect.try({
  try: () => {
    const providers: Record<string, DerivedPiProviderConfig> = {};
    for (const profile of settings.modelProfiles) {
      if (profile.provider.type !== "custom") continue;
      const model = customModelDefinition(profile);
      const candidate: DerivedPiProviderConfig = {
        name: profile.provider.providerId,
        baseUrl: profile.provider.baseUrl,
        api: profile.provider.api,
        models: [model],
      };
      const existing = providers[profile.provider.providerId];
      if (existing === undefined) {
        providers[profile.provider.providerId] = candidate;
        continue;
      }
      if (!sameProvider(existing, candidate)) throw compilerError("provider_conflict");
      if (existing.models.some(({ id }) => id === model.id)) throw compilerError("provider_conflict");
      providers[profile.provider.providerId] = {
        ...existing,
        models: [...existing.models, model],
      };
    }
    return {
      version: 1,
      sourceChecksum: sourceChecksum(settings),
      providers,
    };
  },
  catch: (error) => error instanceof ModelConfigCompilerError
    ? error
    : compilerError("provider_conflict"),
});
