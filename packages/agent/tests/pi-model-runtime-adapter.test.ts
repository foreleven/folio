import type { FetchFunction, ModelsRefreshResult } from "@earendil-works/pi-ai";
import type { CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSettings, ModelProfile } from "../src/config/schema.js";
import {
  compileDerivedPiModelConfig,
  makePiModelRuntimeAdapter,
  SecureCredentialStore,
  serializeDerivedPiModelConfig,
} from "../src/model/index.js";

const temporaryDirectories: string[] = [];

const customProfile = (credentialSource: "managed" | "none" = "managed"): ModelProfile => ({
  id: "custom-profile",
  name: "Custom profile",
  provider: {
    type: "custom",
    providerId: "custom-provider",
    baseUrl: "https://api.example.test/v1",
    api: "openai-completions",
  },
  modelId: "custom-model",
  thinkingLevel: "medium",
  credentialSource,
  customModel: {
    displayName: "Custom model",
    reasoning: false,
    contextWindow: 16_000,
    maxTokens: 4_000,
  },
});

const settingsFor = (...profiles: ModelProfile[]): AgentSettings => ({
  enabled: true,
  modelProfiles: profiles,
  defaultModelProfileId: profiles[0]?.id,
});

const makeFixture = async (profiles: readonly ModelProfile[]) => {
  const directory = await mkdtemp(join(tmpdir(), "folio-pi-runtime-adapter-"));
  temporaryDirectories.push(directory);
  const modelsPath = join(directory, "models.generated.json");
  const modelsStorePath = join(directory, "models-store.json");
  const credentials = new SecureCredentialStore({ authPath: join(directory, "auth.json") });
  const settings = settingsFor(...profiles);
  const compiled = await Effect.runPromise(compileDerivedPiModelConfig(settings));
  await mkdir(directory, { recursive: true });
  await writeFile(modelsPath, serializeDerivedPiModelConfig(compiled), "utf8");
  return { credentials, directory, modelsPath, modelsStorePath, settings };
};

const successfulOpenAiFetch: FetchFunction = async (_input, init) => {
  const authorization = new Headers(init?.headers).get("authorization");
  if (authorization !== "Bearer connection-secret") {
    return new Response("unauthorized", { status: 401 });
  }
  const chunks = [
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 0,
      model: "custom-model",
      choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }],
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 0,
      model: "custom-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ];
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("PiModelRuntimeAdapter", () => {
  it("loads credential-blind builtin and custom catalog entries through the real Pi runtime", async () => {
    const builtin: ModelProfile = {
      id: "builtin-profile",
      name: "Builtin profile",
      provider: { type: "builtin", providerId: "anthropic" },
      modelId: "claude-sonnet-4-5",
      thinkingLevel: "medium",
      credentialSource: "none",
    };
    const fixture = await makeFixture([builtin, customProfile("none")]);
    const adapter = makePiModelRuntimeAdapter(fixture);

    const catalog = await Effect.runPromise(adapter.listCatalog(fixture.settings));
    expect(catalog.stale).toBe(false);
    expect(catalog.models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerId: "anthropic",
        modelId: "claude-sonnet-4-5",
        source: "builtin",
      }),
      expect.objectContaining({
        providerId: "custom-provider",
        providerName: "custom-provider",
        modelId: "custom-model",
        modelName: "Custom model",
        source: "custom",
      }),
    ]));
    expect(JSON.stringify(catalog)).not.toContain("credential");
    expect(JSON.stringify(catalog)).not.toContain("apiKey");
    expect(JSON.stringify(catalog)).not.toContain("headers");
  });

  it("tests a managed custom provider through Pi completeSimple without exposing the key", async () => {
    const profile = customProfile();
    const directory = await mkdtemp(join(tmpdir(), "folio-pi-runtime-adapter-"));
    temporaryDirectories.push(directory);
    const credentials = new SecureCredentialStore({ authPath: join(directory, "auth.json") });
    await credentials.modify("custom-provider", async () => ({ type: "api_key", key: "connection-secret" }));
    const settings = settingsFor(profile);
    const compiled = await Effect.runPromise(compileDerivedPiModelConfig(settings));
    const modelsPath = join(directory, "models.generated.json");
    await writeFile(modelsPath, serializeDerivedPiModelConfig(compiled), "utf8");
    const adapter = makePiModelRuntimeAdapter({
      credentials,
      modelsPath,
      modelsStorePath: join(directory, "models-store.json"),
      requestFetch: successfulOpenAiFetch,
    });

    await expect(Effect.runPromise(adapter.testConnection(profile))).resolves.toBeUndefined();
  });

  it("returns stable secret-free credential and provider failures", async () => {
    const profile = customProfile();
    const missing = await makeFixture([customProfile("none")]);
    const missingAdapter = makePiModelRuntimeAdapter(missing);
    const missingError = await Effect.runPromise(Effect.flip(missingAdapter.testConnection(profile)));
    expect(missingError).toMatchObject({
      _tag: "ModelRuntimeAdapterError",
      reason: "credential_missing",
      message: "Credential is not configured.",
    });

    const directory = await mkdtemp(join(tmpdir(), "folio-pi-runtime-adapter-"));
    temporaryDirectories.push(directory);
    const credentials = new SecureCredentialStore({ authPath: join(directory, "auth.json") });
    await credentials.modify("custom-provider", async () => ({ type: "api_key", key: "provider-failure-secret" }));
    const settings = settingsFor(profile);
    const compiled = await Effect.runPromise(compileDerivedPiModelConfig(settings));
    const modelsPath = join(directory, "models.generated.json");
    await writeFile(modelsPath, serializeDerivedPiModelConfig(compiled), "utf8");
    const unavailable = makePiModelRuntimeAdapter({
      credentials,
      modelsPath,
      modelsStorePath: join(directory, "models-store.json"),
      requestFetch: async () => { throw new Error("provider body provider-failure-secret"); },
    });
    const unavailableError = await Effect.runPromise(Effect.flip(unavailable.testConnection(profile)));
    expect(unavailableError).toMatchObject({
      _tag: "ModelRuntimeAdapterError",
      reason: "provider_unavailable",
      message: "Model provider is unavailable.",
    });
    expect(JSON.stringify([missingError, unavailableError])).not.toContain("provider-failure-secret");
    expect(JSON.stringify([missingError, unavailableError])).not.toContain("cause");
  });

  it("maps damaged generated configuration to a stable secret-free failure", async () => {
    const fixture = await makeFixture([customProfile("none")]);
    await writeFile(fixture.modelsPath, '{"apiKey":"damaged-config-secret"}', "utf8");
    const adapter = makePiModelRuntimeAdapter(fixture);

    const error = await Effect.runPromise(Effect.flip(adapter.listCatalog(fixture.settings)));
    expect(error).toMatchObject({
      _tag: "ModelRuntimeAdapterError",
      reason: "configuration_invalid",
      message: "Model runtime configuration is invalid.",
    });
    expect(JSON.stringify(error)).not.toContain("damaged-config-secret");
    expect(JSON.stringify(error)).not.toContain("cause");
  });

  it("keeps the loaded catalog and marks it stale when network refresh reports errors", async () => {
    const fixture = await makeFixture([customProfile("none")]);
    const refreshResult: ModelsRefreshResult = {
      errors: new Map([["catalog", new Error("offline")]]),
      aborted: false,
    };
    const runtimeFactory = async (options: CreateModelRuntimeOptions) => {
      const actual = await import("@earendil-works/pi-coding-agent").then(({ ModelRuntime }) =>
        ModelRuntime.create(options));
      return new Proxy(actual, {
        get(target, property, receiver) {
          if (property === "refresh") return async () => refreshResult;
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    const adapter = makePiModelRuntimeAdapter({ ...fixture, runtimeFactory });

    const catalog = await Effect.runPromise(adapter.refreshCatalog(fixture.settings));
    expect(catalog.stale).toBe(true);
    expect(catalog.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerId: "custom-provider", modelId: "custom-model" }),
    ]));
  });
});
