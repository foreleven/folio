import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime, CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { access, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSettings, ModelProfile } from "../src/config/schema.js";
import type { FolioAgentConfigSnapshot } from "../src/config/loader.js";
import { SecureCredentialStore } from "../src/model/credential-store.js";
import {
  AgentRuntimeCompositionError,
  makeFolioAgentRuntimeComposition,
} from "../src/runtime/composition.js";
import type { PiSessionFactoryOptions } from "../src/pi/session-factory.js";

const temporaryDirectories: string[] = [];

const model: Model<Api> = {
  id: "test-model",
  name: "Test model",
  api: "openai-completions",
  provider: "test-provider",
  baseUrl: "https://api.example.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16_000,
  maxTokens: 4_000,
};

const profile = (
  credentialSource: "managed" | "environment" | "none",
): ModelProfile => ({
  id: "default-profile",
  name: "Default profile",
  provider: {
    type: "custom",
    providerId: model.provider,
    baseUrl: model.baseUrl,
    api: "openai-completions",
  },
  modelId: model.id,
  thinkingLevel: "medium",
  credentialSource,
  ...(credentialSource === "environment" ? { environmentVariable: "FOLIO_TEST_API_KEY" } : {}),
  customModel: {
    displayName: model.name,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  },
});

const snapshot = async (
  credentialSource: "managed" | "environment" | "none",
): Promise<FolioAgentConfigSnapshot> => {
  const configDirectory = await mkdtemp(join(tmpdir(), "folio-runtime-composition-"));
  temporaryDirectories.push(configDirectory);
  const agentDirectory = join(configDirectory, "agent");
  const defaultProfile = profile(credentialSource);
  const settings: AgentSettings = {
    enabled: true,
    modelProfiles: [defaultProfile],
    defaultModelProfileId: defaultProfile.id,
  };
  return { configDirectory, agentDirectory, settings, defaultProfile };
};

class FakeRuntime {
  readonly setRuntimeApiKey = vi.fn(async () => undefined);
  readonly removeRuntimeApiKey = vi.fn(async () => undefined);
  readonly getError = vi.fn(() => undefined as string | undefined);
  readonly getModel = vi.fn((providerId: string, modelId: string) =>
    providerId === model.provider && modelId === model.id ? model : undefined);
}

const makeRuntimeHarness = () => {
  const runtime = new FakeRuntime();
  const runtimeFactory = vi.fn(async (_options: CreateModelRuntimeOptions) => runtime as unknown as ModelRuntime);
  const factoryOptions: PiSessionFactoryOptions[] = [];
  const sessionFactoryBuilder = vi.fn((options: PiSessionFactoryOptions) => {
    factoryOptions.push(options);
    return {
      create: () => Effect.die("session creation is outside this composition test"),
    };
  });
  return { factoryOptions, runtime, runtimeFactory, sessionFactoryBuilder };
};

const expectSecretFreeFailure = async (
  effect: Effect.Effect<unknown, AgentRuntimeCompositionError>,
  reason: AgentRuntimeCompositionError["reason"],
  secret: string,
) => {
  const error = await Effect.runPromise(Effect.flip(effect));
  expect(error).toMatchObject({ _tag: "AgentRuntimeCompositionError", reason });
  expect(JSON.stringify(error)).not.toContain(secret);
  expect(JSON.stringify(error)).not.toContain("cause");
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("Folio Agent runtime composition", () => {
  it("builds a credential-blind shared runtime from the managed Folio credential store", async () => {
    const input = await snapshot("managed");
    const secret = "managed-runtime-secret";
    const credentials = new SecureCredentialStore({ authPath: join(input.agentDirectory, "auth.json") });
    await credentials.modify(model.provider, async () => ({ type: "api_key", key: secret }));
    const harness = makeRuntimeHarness();
    const composition = makeFolioAgentRuntimeComposition(input, harness);

    const initialized = await Effect.runPromise(composition.initialize);

    expect(initialized).toMatchObject({
      profileId: "default-profile",
      providerId: model.provider,
      modelId: model.id,
      modelRuntime: harness.runtime,
    });
    expect(harness.runtimeFactory).toHaveBeenCalledOnce();
    const runtimeOptions = harness.runtimeFactory.mock.calls[0]![0];
    expect(await runtimeOptions.credentials!.read(model.provider)).toEqual({ type: "api_key", key: secret });
    expect(runtimeOptions).toMatchObject({
      modelsPath: join(input.agentDirectory, "models.generated.json"),
      modelsStorePath: join(input.agentDirectory, "models-store.json"),
      allowModelNetwork: false,
      refreshOnCreate: true,
    });
    expect(harness.runtime.setRuntimeApiKey).not.toHaveBeenCalled();
    expect(harness.factoryOptions).toHaveLength(1);
    expect(harness.factoryOptions[0]).toMatchObject({
      agentDirectory: input.agentDirectory,
      modelRuntime: harness.runtime,
      profile: { profileId: "default-profile", model, thinkingLevel: "medium" },
    });
    expect(JSON.stringify(harness.factoryOptions[0])).not.toContain(secret);

    const generated = await readFile(join(input.agentDirectory, "models.generated.json"), "utf8");
    expect(generated).toContain("sourceChecksum: sha256:");
    expect(generated).toContain(model.id);
    expect(generated).not.toContain(secret);
    expect(generated).not.toContain("credentialSource");
    expect(generated).not.toContain("apiKey");
    expect((await lstat(input.agentDirectory)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(input.agentDirectory, "models.generated.json"))).mode & 0o777).toBe(0o600);
  });

  it("keeps environment credentials in Pi's runtime overlay only and removes them on shutdown", async () => {
    const input = await snapshot("environment");
    const secret = "environment-runtime-secret";
    const harness = makeRuntimeHarness();
    const composition = makeFolioAgentRuntimeComposition(input, {
      ...harness,
      env: { FOLIO_TEST_API_KEY: secret },
    });

    await Effect.runPromise(composition.initialize);
    expect(harness.runtime.setRuntimeApiKey).toHaveBeenCalledWith(
      model.provider,
      secret,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await expect(access(join(input.agentDirectory, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(input.agentDirectory, "models.generated.json"), "utf8")).not.toContain(secret);

    await composition.shutdown();
    await composition.shutdown();
    expect(harness.runtime.removeRuntimeApiKey).toHaveBeenCalledOnce();
    expect(harness.runtime.removeRuntimeApiKey).toHaveBeenCalledWith(model.provider);
  });

  it("loads a custom environment profile through the real Pi ModelRuntime without persisting the key", async () => {
    const input = await snapshot("environment");
    const secret = "real-pi-environment-secret";
    const sessionFactoryBuilder = vi.fn((options: PiSessionFactoryOptions) => ({
      create: () => Effect.die(`unused ${options.profile.profileId}`),
    }));
    const composition = makeFolioAgentRuntimeComposition(input, {
      env: { FOLIO_TEST_API_KEY: secret },
      sessionFactoryBuilder,
    });

    const initialized = await Effect.runPromise(composition.initialize);

    expect(initialized.modelRuntime.getModel(model.provider, model.id)).toMatchObject({
      provider: model.provider,
      id: model.id,
      api: model.api,
    });
    expect(initialized.modelRuntime.getProviderAuthStatus(model.provider)).toEqual({
      configured: true,
      source: "runtime",
    });
    expect(await initialized.modelRuntime.listCredentials()).toContainEqual({
      providerId: model.provider,
      type: "api_key",
    });
    const authSource = await readFile(join(input.agentDirectory, "auth.json"), "utf8");
    expect(JSON.parse(authSource)).toEqual({});
    expect(authSource).not.toContain(secret);
    expect((await lstat(join(input.agentDirectory, "auth.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(input.agentDirectory, "models.generated.json"), "utf8")).not.toContain(secret);

    await composition.shutdown();
    expect(initialized.modelRuntime.getProviderAuthStatus(model.provider)).toEqual({ configured: false });
  });

  it("removes a partially installed environment overlay when Pi synchronization fails", async () => {
    const input = await snapshot("environment");
    const secret = "environment-sync-failure-secret";
    const harness = makeRuntimeHarness();
    harness.runtime.setRuntimeApiKey.mockRejectedValueOnce(new Error(`sync failed ${secret}`));
    const composition = makeFolioAgentRuntimeComposition(input, {
      ...harness,
      env: { FOLIO_TEST_API_KEY: secret },
    });

    await expectSecretFreeFailure(composition.initialize, "runtime_unavailable", secret);

    expect(harness.runtime.removeRuntimeApiKey).toHaveBeenCalledOnce();
    expect(harness.runtime.removeRuntimeApiKey).toHaveBeenCalledWith(model.provider);
    await expect(access(join(input.agentDirectory, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("supports explicit no-credential profiles without creating auth.json", async () => {
    const input = await snapshot("none");
    const harness = makeRuntimeHarness();
    const composition = makeFolioAgentRuntimeComposition(input, harness);

    await Effect.runPromise(composition.initialize);

    expect(harness.runtime.setRuntimeApiKey).not.toHaveBeenCalled();
    await expect(access(join(input.agentDirectory, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns stable secret-free missing credential and runtime failures", async () => {
    const missingInput = await snapshot("managed");
    const missingHarness = makeRuntimeHarness();
    await expectSecretFreeFailure(
      makeFolioAgentRuntimeComposition(missingInput, missingHarness).initialize,
      "credential_missing",
      "missing-secret-sentinel",
    );

    const unavailableInput = await snapshot("environment");
    const secret = "runtime-factory-secret";
    const unavailable = makeFolioAgentRuntimeComposition(unavailableInput, {
      env: { FOLIO_TEST_API_KEY: secret },
      runtimeFactory: async () => { throw new Error(`provider failed ${secret}`); },
    });
    await expectSecretFreeFailure(unavailable.initialize, "runtime_unavailable", secret);
  });

  it("maps composition failure to the existing stable Pi session factory boundary", async () => {
    const input = await snapshot("managed");
    const composition = makeFolioAgentRuntimeComposition(input, makeRuntimeHarness());

    const error = await Effect.runPromise(Effect.flip(composition.sessionFactory.create("/workspace")));

    expect(error).toMatchObject({
      _tag: "PiSessionFactoryError",
      reason: "session_unavailable",
      message: "Pi session could not be created.",
    });
    expect(JSON.stringify(error)).not.toContain("credential");
  });
});
