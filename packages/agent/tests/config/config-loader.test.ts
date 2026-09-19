import { Effect } from "effect";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentConfigLoadError, loadFolioAgentConfig } from "../../src/config/loader.js";

const roots: string[] = [];

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "folio-agent-config-loader-"));
  roots.push(root);
  return root;
};

const profile = {
  id: "standalone-default",
  name: "Standalone default",
  provider: { type: "builtin", providerId: "anthropic" },
  modelId: "claude-sonnet-4-5",
  thinkingLevel: "medium",
  credentialSource: "none",
} as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("loadFolioAgentConfig", () => {
  it("loads the strict AgentSettings subtree and resolves the default profile", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "config.json"), JSON.stringify({
      theme: "dark",
      language: "en",
      vaults: [],
      agent: {
        enabled: true,
        modelProfiles: [profile],
        defaultModelProfileId: profile.id,
      },
    }), "utf8");

    await expect(Effect.runPromise(loadFolioAgentConfig({ env: { FOLIO_CONFIG_DIR: root } })))
      .resolves.toEqual({
        configDirectory: root,
        agentDirectory: join(root, "agent"),
        settings: {
          enabled: true,
          modelProfiles: [profile],
          defaultModelProfileId: profile.id,
        },
        defaultProfile: profile,
      });
  });

  it("uses a strict Session snapshot independently of global defaults and rejects secret fields", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "config.json"), "damaged global config");
    const env = { FOLIO_CONFIG_DIR: root, FOLIO_SESSION_MODEL_PROFILE: JSON.stringify(profile) };
    expect(await Effect.runPromise(loadFolioAgentConfig({ env }))).toMatchObject({
      defaultProfile: profile, settings: { enabled: true, modelProfiles: [profile], defaultModelProfileId: profile.id },
    });
    const error = await Effect.runPromise(Effect.flip(loadFolioAgentConfig({ env: {
      ...env, FOLIO_SESSION_MODEL_PROFILE: JSON.stringify({ ...profile, apiKey: "secret-sentinel" }),
    } })));
    expect(error.reason).toBe("configuration_invalid");
    expect(JSON.stringify(error)).not.toContain("secret-sentinel");
    expect(await import("node:fs/promises").then(fs => fs.readFile(join(root, "config.json"), "utf8"))).toBe("damaged global config");
  });

  it("uses safe disabled defaults only when config.json is absent", async () => {
    const root = await makeRoot();
    await expect(Effect.runPromise(loadFolioAgentConfig({ env: { FOLIO_CONFIG_DIR: root } })))
      .resolves.toEqual({
        configDirectory: root,
        agentDirectory: join(root, "agent"),
        settings: { enabled: false, modelProfiles: [] },
      });
  });

  it("returns stable secret-free errors for damaged or unreadable config", async () => {
    const root = await makeRoot();
    const secret = "loader-must-not-leak";
    await writeFile(join(root, "config.json"), JSON.stringify({
      agent: {
        enabled: true,
        modelProfiles: [{ ...profile, apiKey: secret }],
        defaultModelProfileId: profile.id,
      },
    }), "utf8");

    const invalid = await Effect.runPromise(Effect.flip(
      loadFolioAgentConfig({ env: { FOLIO_CONFIG_DIR: root } }),
    ));
    expect(invalid).toEqual(new AgentConfigLoadError({
      reason: "configuration_invalid",
      message: "Agent configuration is invalid.",
    }));
    expect(JSON.stringify(invalid)).not.toContain(secret);
    expect(JSON.stringify(invalid)).not.toContain("cause");

    const unavailable = await Effect.runPromise(Effect.flip(loadFolioAgentConfig({
      env: { FOLIO_CONFIG_DIR: root },
      readConfigFile: async () => {
        throw new Error(secret);
      },
    })));
    expect(unavailable).toEqual(new AgentConfigLoadError({
      reason: "configuration_unavailable",
      message: "Agent configuration is unavailable.",
    }));
    expect(JSON.stringify(unavailable)).not.toContain(secret);
  });
});
