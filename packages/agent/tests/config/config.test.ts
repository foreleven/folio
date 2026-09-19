import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
  decodeAgentSettings,
  resolveFolioAgentDirectory,
  resolveFolioConfigDirectory,
} from "../../src/config/index.js";

const validProfile = {
  id: "profile-1",
  name: "Default",
  provider: { type: "builtin", providerId: "anthropic" },
  modelId: "claude-sonnet-4-5",
  thinkingLevel: "medium",
  credentialSource: "managed",
} as const;

const decode = (input: unknown) => Effect.runPromise(decodeAgentSettings(input));

const expectDecodeFailure = async (input: unknown): Promise<void> => {
  const exit = await Effect.runPromiseExit(decodeAgentSettings(input));
  expect(Exit.isFailure(exit)).toBe(true);
};

describe("AgentSettings schema", () => {
  it("migrates legacy config input to safe disabled defaults", async () => {
    await expect(decode({})).resolves.toEqual({
      enabled: false,
      modelProfiles: [],
    });
  });

  it("accepts a complete non-sensitive built-in profile", async () => {
    await expect(
      decode({
        enabled: true,
        modelProfiles: [validProfile],
        defaultModelProfileId: validProfile.id,
      }),
    ).resolves.toEqual({
      enabled: true,
      modelProfiles: [validProfile],
      defaultModelProfileId: validProfile.id,
    });
  });

  it("rejects unknown fields including secrets and arbitrary headers", async () => {
    await expectDecodeFailure({
      enabled: true,
      modelProfiles: [{ ...validProfile, apiKey: "must-not-enter-config" }],
    });
    await expectDecodeFailure({
      enabled: true,
      modelProfiles: [{ ...validProfile, headers: { Authorization: "must-not-enter-config" } }],
    });
  });

  it("rejects duplicate ids and a stale default profile reference", async () => {
    await expectDecodeFailure({
      enabled: true,
      modelProfiles: [validProfile, { ...validProfile, name: "Duplicate" }],
    });
    await expectDecodeFailure({
      enabled: true,
      modelProfiles: [validProfile],
      defaultModelProfileId: "missing",
    });
  });

  it("enforces environment credential and custom provider invariants", async () => {
    await expectDecodeFailure({
      enabled: true,
      modelProfiles: [{ ...validProfile, credentialSource: "environment" }],
    });
    await expectDecodeFailure({
      enabled: true,
      modelProfiles: [{
        ...validProfile,
        credentialSource: "environment",
        environmentVariable: "INVALID-NAME",
      }],
    });
    await expectDecodeFailure({
      enabled: true,
      modelProfiles: [{ ...validProfile, environmentVariable: "SHOULD_NOT_BE_PRESENT" }],
    });
    await expectDecodeFailure({
      enabled: true,
      modelProfiles: [{
        ...validProfile,
        provider: {
          type: "custom",
          providerId: "compatible-provider",
          baseUrl: "http://insecure.example/v1",
          api: "openai-completions",
        },
      }],
    });
    await expectDecodeFailure({
      enabled: true,
      modelProfiles: [{
        ...validProfile,
        provider: {
          type: "custom",
          providerId: "compatible-provider",
          baseUrl: "https://api.example/v1",
          api: "unsupported-api",
        },
        customModel: {
          displayName: "Example",
          reasoning: false,
          contextWindow: 8_000,
          maxTokens: 16_000,
        },
      }],
    });
  });
});

describe("resolveFolioAgentDirectory", () => {
  it("uses the default Folio-owned location", () => {
    expect(resolveFolioConfigDirectory({ env: {}, homeDirectory: "/home/tester" }))
      .toBe("/home/tester/.folio");
    expect(resolveFolioAgentDirectory({ env: {}, homeDirectory: "/home/tester" }))
      .toBe("/home/tester/.folio/agent");
  });

  it("derives from FOLIO_CONFIG_DIR and lets FOLIO_AGENT_DIR win", () => {
    expect(resolveFolioAgentDirectory({
      env: { FOLIO_CONFIG_DIR: "~/config" },
      homeDirectory: "/home/tester",
    })).toBe("/home/tester/config/agent");

    expect(resolveFolioAgentDirectory({
      env: {
        FOLIO_CONFIG_DIR: "/ignored",
        FOLIO_AGENT_DIR: "/var/lib/folio-agent",
      },
      homeDirectory: "/home/tester",
    })).toBe("/var/lib/folio-agent");
  });
});
