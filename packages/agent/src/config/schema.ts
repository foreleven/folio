import { Effect, Schema } from "effect";

const requiredString = (label: string) =>
  Schema.String.check(Schema.isMinLength(1, { expected: `${label} must not be empty` }));

const identifier = (label: string) =>
  requiredString(label).check(
    Schema.makeFilter((value) => value === value.trim(), {
      expected: `${label} must not have leading or trailing whitespace`,
    }),
  );

export const ThinkingLevel = Schema.Literals([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ThinkingLevel = typeof ThinkingLevel.Type;

export const CredentialSource = Schema.Literals(["managed", "environment", "none"]);
export type CredentialSource = typeof CredentialSource.Type;

/** M1 intentionally supports only the two compatible custom-provider APIs approved by the RFC. */
export const SupportedCustomProviderApi = Schema.Literals([
  "openai-completions",
  "anthropic-messages",
]);
export type SupportedCustomProviderApi = typeof SupportedCustomProviderApi.Type;

export const BuiltinProvider = Schema.Struct({
  type: Schema.Literal("builtin"),
  providerId: identifier("providerId"),
});
export type BuiltinProvider = typeof BuiltinProvider.Type;

const HttpsUrl = requiredString("baseUrl").check(
  Schema.makeFilter((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, { expected: "an absolute https URL" }),
);

export const CustomProvider = Schema.Struct({
  type: Schema.Literal("custom"),
  providerId: identifier("providerId"),
  baseUrl: HttpsUrl,
  api: SupportedCustomProviderApi,
});
export type CustomProvider = typeof CustomProvider.Type;

export const ModelProvider = Schema.Union([BuiltinProvider, CustomProvider]);
export type ModelProvider = typeof ModelProvider.Type;

export const CustomModel = Schema.Struct({
  displayName: requiredString("displayName"),
  reasoning: Schema.Boolean,
  contextWindow: Schema.Int.check(Schema.isGreaterThan(0)),
  maxTokens: Schema.Int.check(Schema.isGreaterThan(0)),
}).check(
  Schema.makeFilter(({ contextWindow, maxTokens }) => maxTokens <= contextWindow, {
    expected: "maxTokens must not exceed contextWindow",
  }),
);
export type CustomModel = typeof CustomModel.Type;

const EnvironmentVariable = identifier("environmentVariable").check(
  Schema.makeFilter((value) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value), {
    expected: "a valid environment variable name",
  }),
);

const ModelProfileFields = Schema.Struct({
  id: identifier("id"),
  name: requiredString("name"),
  provider: ModelProvider,
  modelId: identifier("modelId"),
  thinkingLevel: ThinkingLevel,
  credentialSource: CredentialSource,
  environmentVariable: Schema.optionalKey(EnvironmentVariable),
  customModel: Schema.optionalKey(CustomModel),
});

/** Non-sensitive model selection. Secret values and arbitrary headers are deliberately absent. */
export const ModelProfile = ModelProfileFields.check(
  Schema.makeFilter(
    ({ credentialSource, environmentVariable }) =>
      credentialSource === "environment" ? environmentVariable !== undefined : environmentVariable === undefined,
    { expected: "environmentVariable must be present only when credentialSource is environment" },
  ),
  Schema.makeFilter(
    ({ provider, customModel }) => provider.type === "builtin" ? customModel === undefined : true,
    { expected: "customModel is allowed only for custom providers" },
  ),
);
export type ModelProfile = typeof ModelProfile.Type;

const AgentSettingsFields = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  modelProfiles: Schema.Array(ModelProfile).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  defaultModelProfileId: Schema.optionalKey(identifier("defaultModelProfileId")),
});

export const AgentSettings = AgentSettingsFields.check(
  Schema.makeFilter(
    ({ modelProfiles }) => new Set(modelProfiles.map(({ id }) => id)).size === modelProfiles.length,
    { expected: "model profile ids must be unique" },
  ),
  Schema.makeFilter(
    ({ modelProfiles, defaultModelProfileId }) =>
      defaultModelProfileId === undefined || modelProfiles.some(({ id }) => id === defaultModelProfileId),
    { expected: "defaultModelProfileId must reference an existing model profile" },
  ),
);
export type AgentSettings = typeof AgentSettings.Type;

export const decodeAgentSettings = (input: unknown) =>
  Schema.decodeUnknownEffect(AgentSettings)(input, { onExcessProperty: "error", errors: "all" });
