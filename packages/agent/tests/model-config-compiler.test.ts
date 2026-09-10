import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import type { AgentSettings, ModelProfile } from "../src/config/index.js";
import {
  compileDefaultModelProfile,
  compileDerivedPiModelConfig,
  compileModelProfile,
  ModelConfigCompilerError,
  serializeDerivedPiModelConfig,
} from "../src/model/index.js";

const builtinProfile: ModelProfile = {
  id: "builtin-default",
  name: "Built-in",
  provider: { type: "builtin", providerId: "anthropic" },
  modelId: "claude-sonnet-4-5",
  thinkingLevel: "medium",
  credentialSource: "managed",
};

const customProfile = (overrides: Partial<ModelProfile> = {}): ModelProfile => ({
  id: "custom-default",
  name: "Custom",
  provider: {
    type: "custom",
    providerId: "compatible-provider",
    baseUrl: "https://api.example.test/v1",
    api: "openai-completions",
  },
  modelId: "example-model",
  thinkingLevel: "high",
  credentialSource: "environment",
  environmentVariable: "EXAMPLE_API_KEY",
  customModel: {
    displayName: "Example Model",
    reasoning: true,
    contextWindow: 32_000,
    maxTokens: 8_000,
  },
  ...overrides,
});

const settings = (profiles: readonly ModelProfile[], defaultModelProfileId?: string): AgentSettings => ({
  enabled: true,
  modelProfiles: profiles,
  ...(defaultModelProfileId === undefined ? {} : { defaultModelProfileId }),
});

const memoryCredentials = (entries: Record<string, Credential> = {}): CredentialStore => ({
  read: async (providerId) => entries[providerId],
  list: async () => Object.entries(entries).map(([providerId, credential]) => ({
    providerId,
    type: credential.type,
  })),
  modify: async (providerId, fn) => fn(entries[providerId]),
  delete: async () => undefined,
});

const runFailure = async <A>(effect: Effect.Effect<A, ModelConfigCompilerError>) => {
  const exit = await Effect.runPromiseExit(effect);
  expect(Exit.isFailure(exit)).toBe(true);
  return JSON.stringify(exit);
};

describe("model config compiler", () => {
  it("compiles a built-in catalog model and verifies the managed credential without exposing it", async () => {
    const compiled = await Effect.runPromise(compileDefaultModelProfile(
      settings([builtinProfile], builtinProfile.id),
      { credentials: memoryCredentials({ anthropic: { type: "api_key", key: "managed-secret" } }) },
    ));

    expect(compiled.profileId).toBe(builtinProfile.id);
    expect(compiled.model).toMatchObject({
      provider: "anthropic",
      id: "claude-sonnet-4-5",
    });
    expect(compiled.thinkingLevel).toBe("medium");
    expect(compiled.credential).toEqual({ source: "managed" });
    expect(compiled.providerRegistration).toBeUndefined();
    expect(JSON.stringify(compiled)).not.toContain("managed-secret");
  });

  it("compiles a custom provider into Pi Model and registerProvider input", async () => {
    const profile = customProfile();
    const compiled = await Effect.runPromise(compileModelProfile(profile, {
      env: { EXAMPLE_API_KEY: "environment-secret" },
    }));

    expect(compiled.model).toEqual({
      id: "example-model",
      name: "Example Model",
      api: "openai-completions",
      provider: "compatible-provider",
      baseUrl: "https://api.example.test/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: 8_000,
    });
    expect(compiled.providerRegistration).toEqual({
      providerId: "compatible-provider",
      config: {
        name: "compatible-provider",
        baseUrl: "https://api.example.test/v1",
        api: "openai-completions",
        models: [{
          id: "example-model",
          name: "Example Model",
          api: "openai-completions",
          baseUrl: "https://api.example.test/v1",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32_000,
          maxTokens: 8_000,
        }],
      },
    });
    expect(compiled.credential.source).toBe("environment");
    if (compiled.credential.source === "environment") {
      expect(Redacted.value(compiled.credential.apiKey)).toBe("environment-secret");
    }
    expect(JSON.stringify(compiled)).not.toContain("environment-secret");
    expect(String(compiled.credential)).not.toContain("environment-secret");
  });

  it("supports explicit no-credential profiles without reading a store or environment", async () => {
    const profile = customProfile({
      credentialSource: "none",
      environmentVariable: undefined,
    });
    const compiled = await Effect.runPromise(compileModelProfile(profile));
    expect(compiled.credential).toEqual({ source: "none" });
  });

  it("returns stable failures for disabled/default/profile/catalog/model/metadata boundaries", async () => {
    expect(await runFailure(compileDefaultModelProfile({
      enabled: false,
      modelProfiles: [],
    }))).toContain("agent_disabled");
    expect(await runFailure(compileDefaultModelProfile(settings([builtinProfile])))).toContain("default_profile_missing");
    expect(await runFailure(compileDefaultModelProfile({
      enabled: true,
      modelProfiles: [builtinProfile],
      defaultModelProfileId: "stale-profile",
    }))).toContain("profile_not_found");
    expect(await runFailure(compileModelProfile({
      ...builtinProfile,
      provider: { type: "builtin", providerId: "unknown-provider" },
    }, { credentials: memoryCredentials() }))).toContain("builtin_provider_unknown");
    expect(await runFailure(compileModelProfile({
      ...builtinProfile,
      modelId: "missing-model",
    }, { credentials: memoryCredentials() }))).toContain("model_not_found");
    expect(await runFailure(compileModelProfile({
      ...customProfile(),
      customModel: undefined,
    }, { env: { EXAMPLE_API_KEY: "secret" } }))).toContain("model_metadata_missing");
  });

  it("distinguishes missing managed/environment credentials and store failure without leaking values", async () => {
    const managedMissing = await runFailure(compileModelProfile(builtinProfile, {
      credentials: memoryCredentials(),
    }));
    expect(managedMissing).toContain("credential_missing");

    const envMissing = await runFailure(compileModelProfile(customProfile(), {
      env: { EXAMPLE_API_KEY: "" },
    }));
    expect(envMissing).toContain("credential_missing");
    expect(envMissing).not.toContain("EXAMPLE_API_KEY");

    const storageSecret = "storage-failure-secret";
    const unavailable: CredentialStore = {
      ...memoryCredentials(),
      read: async () => { throw new Error(storageSecret); },
    };
    const storeFailure = await runFailure(compileModelProfile(builtinProfile, { credentials: unavailable }));
    expect(storeFailure).toContain("credential_store_unavailable");
    expect(storeFailure).not.toContain(storageSecret);
  });

  it("builds a deterministic credential-blind derived config with source checksum", async () => {
    const first = customProfile();
    const second = customProfile({
      id: "custom-secondary",
      name: "Secondary",
      modelId: "another-model",
      credentialSource: "managed",
      environmentVariable: undefined,
      customModel: {
        displayName: "Another Model",
        reasoning: false,
        contextWindow: 16_000,
        maxTokens: 4_000,
      },
    });
    const input = settings([builtinProfile, first, second], first.id);
    const one = await Effect.runPromise(compileDerivedPiModelConfig(input));
    const two = await Effect.runPromise(compileDerivedPiModelConfig(structuredClone(input)));

    expect(one).toEqual(two);
    expect(one.sourceChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(one.providers["compatible-provider"]?.models.map(({ id }) => id)).toEqual([
      "example-model",
      "another-model",
    ]);
    const serialized = serializeDerivedPiModelConfig(one);
    expect(serialized).toContain(`// sourceChecksum: sha256:${one.sourceChecksum}`);
    expect(serialized).not.toContain("credentialSource");
    expect(serialized).not.toContain("environmentVariable");
    expect(serialized).not.toContain("EXAMPLE_API_KEY");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("headers");
  });

  it("produces a snapshot accepted by Pi ModelRuntime", async () => {
    const profile = customProfile({ credentialSource: "none", environmentVariable: undefined });
    const derived = await Effect.runPromise(compileDerivedPiModelConfig(settings([profile], profile.id)));
    const directory = await mkdtemp(join(tmpdir(), "folio-model-compiler-"));
    const modelsPath = join(directory, "models.generated.json");
    try {
      await writeFile(modelsPath, serializeDerivedPiModelConfig(derived), "utf8");
      const runtime = await ModelRuntime.create({
        credentials: memoryCredentials(),
        modelsPath,
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      expect(runtime.getError()).toBeUndefined();
      expect(runtime.getModel("compatible-provider", "example-model")).toMatchObject({
        provider: "compatible-provider",
        id: "example-model",
        api: "openai-completions",
        baseUrl: "https://api.example.test/v1",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects conflicting custom provider definitions instead of silently overriding", async () => {
    const conflicting = customProfile({
      id: "conflicting",
      modelId: "conflicting-model",
      provider: {
        type: "custom",
        providerId: "compatible-provider",
        baseUrl: "https://different.example.test/v1",
        api: "anthropic-messages",
      },
    });

    const failure = await runFailure(compileDerivedPiModelConfig(settings([
      customProfile(),
      conflicting,
    ], "custom-default")));
    expect(failure).toContain("provider_conflict");
    expect(failure).not.toContain("different.example.test");
  });
});
