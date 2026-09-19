import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
} from "@agentclientprotocol/sdk/experimental/v2";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";

describe("folio-agent stdio", () => {
  it("creates and closes a real no-tool Pi session through the ACP v2 client", async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), "folio-agent-stdio-"));
    await writeFile(join(configDirectory, "config.json"), JSON.stringify({
      agent: {
        enabled: true,
        modelProfiles: [{
          id: "stdio-default",
          name: "Stdio default",
          provider: { type: "builtin", providerId: "anthropic" },
          modelId: "claude-sonnet-4-5",
          thinkingLevel: "medium",
          credentialSource: "none",
        }],
        defaultModelProfileId: "stdio-default",
      },
    }), "utf8");
    const child = spawn(process.execPath, [resolve("dist/cli.js")], {
      cwd: resolve("."),
      env: { ...process.env, FOLIO_CONFIG_DIR: configDirectory },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    try {
      const stream = ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      );

      await client().connectWith(stream, async (context) => {
        const initialized = await context.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          info: { name: "stdio-test", version: "0.1.0" },
          capabilities: {},
        });
        expect(initialized).toMatchObject({ protocolVersion: 2, capabilities: { session: {} } });

        const created = await context.request(methods.agent.session.new, { cwd: "/workspace" });
        expect(created.configOptions).toEqual(expect.arrayContaining([
          expect.objectContaining({
            type: "select",
            configId: "model",
            category: "model",
            currentValue: expect.any(String),
          }),
          expect.objectContaining({
            type: "select",
            configId: "thought_level",
            category: "thought_level",
            currentValue: expect.any(String),
          }),
        ]));
        const updated = await context.request(methods.agent.session.setConfigOption, {
          sessionId: created.sessionId,
          configId: "thought_level",
          type: "id",
          value: "off",
        });
        expect(updated.configOptions.find(({ configId }) => configId === "thought_level")).toMatchObject({
          currentValue: "off",
        });
        await context.request(methods.agent.session.close, { sessionId: created.sessionId });
      });

      if (child.exitCode === null) child.kill("SIGTERM");
      await new Promise<void>((resolveExit, reject) => {
        if (child.exitCode !== null) {
          resolveExit();
          return;
        }
        child.once("exit", () => resolveExit());
        child.once("error", reject);
      });
      expect(stderr).toContain("default model loaded anthropic/claude-sonnet-4-5");
      expect(stderr).toContain("session created");
      expect(stderr).toContain("session closed");
      const generated = await readFile(join(configDirectory, "agent", "models.generated.json"), "utf8");
      expect(generated).toContain("sourceChecksum: sha256:");
      expect(generated).not.toContain("apiKey");
      expect(generated).not.toContain("credentialSource");
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      await rm(configDirectory, { recursive: true, force: true });
    }
  });

  it("keeps ACP initialize available and rejects session creation when a managed credential is missing", async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), "folio-agent-stdio-missing-credential-"));
    const secret = "missing-credential-secret-sentinel";
    await writeFile(join(configDirectory, "config.json"), JSON.stringify({
      agent: {
        enabled: true,
        modelProfiles: [{
          id: "stdio-managed",
          name: "Stdio managed",
          provider: {
            type: "custom",
            providerId: "stdio-provider",
            baseUrl: "https://api.example.test/v1",
            api: "openai-completions",
          },
          modelId: "stdio-model",
          thinkingLevel: "medium",
          credentialSource: "managed",
          customModel: {
            displayName: "Stdio model",
            reasoning: false,
            contextWindow: 16_000,
            maxTokens: 4_000,
          },
        }],
        defaultModelProfileId: "stdio-managed",
      },
    }), "utf8");
    const child = spawn(process.execPath, [resolve("dist/cli.js")], {
      cwd: resolve("."),
      env: { ...process.env, FOLIO_CONFIG_DIR: configDirectory },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));

    try {
      const stream = ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      );
      await client().connectWith(stream, async (context) => {
        await expect(context.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          info: { name: "stdio-test", version: "0.1.0" },
          capabilities: {},
        })).resolves.toMatchObject({ protocolVersion: 2 });
        await expect(context.buildSession("/workspace").start()).rejects.toBeDefined();
      });

      if (child.exitCode === null) child.kill("SIGTERM");
      await new Promise<void>((resolveExit, reject) => {
        if (child.exitCode !== null) return resolveExit();
        child.once("exit", () => resolveExit());
        child.once("error", reject);
      });
      const diagnostics = Buffer.concat(stderr).toString();
      expect(diagnostics).toContain("default model loaded stdio-provider/stdio-model");
      expect(diagnostics).not.toContain(secret);
      const generated = await readFile(join(configDirectory, "agent", "models.generated.json"), "utf8");
      expect(generated).toContain("stdio-model");
      expect(generated).not.toContain(secret);
      expect(generated).not.toContain("credentialSource");
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      await rm(configDirectory, { recursive: true, force: true });
    }
  });

  it("fails closed without stdout or secret leakage when config.json is damaged", async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), "folio-agent-stdio-invalid-"));
    const secret = "stdio-config-secret";
    await writeFile(join(configDirectory, "config.json"), JSON.stringify({
      agent: {
        enabled: true,
        modelProfiles: [{
          id: "invalid",
          name: "Invalid",
          provider: { type: "builtin", providerId: "anthropic" },
          modelId: "claude-sonnet-4-5",
          thinkingLevel: "medium",
          credentialSource: "none",
          apiKey: secret,
        }],
        defaultModelProfileId: "invalid",
      },
    }), "utf8");
    try {
      const child = spawn(process.execPath, [resolve("dist/cli.js")], {
        cwd: resolve("."),
        env: { ...process.env, FOLIO_CONFIG_DIR: configDirectory },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      const exitCode = await new Promise<number | null>((resolveExit, reject) => {
        child.once("exit", resolveExit);
        child.once("error", reject);
      });
      const output = Buffer.concat(stdout).toString();
      const diagnostics = Buffer.concat(stderr).toString();
      expect(exitCode).toBe(1);
      expect(output).toBe("");
      expect(diagnostics).toBe("Agent configuration is invalid.\n");
      expect(diagnostics).not.toContain(secret);
    } finally {
      await rm(configDirectory, { recursive: true, force: true });
    }
  });
});
