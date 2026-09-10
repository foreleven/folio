#!/usr/bin/env node
import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
} from "@agentclientprotocol/sdk/experimental/v2";
import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { rejectsPersonalOpenAiCredential } from "./live-provider-policy.mjs";

const OPT_IN = "FOLIO_AGENT_LIVE_PROVIDER";
const CONFIG_DIRECTORY = "FOLIO_CONFIG_DIR";
const AGENT_DIRECTORY = "FOLIO_AGENT_DIR";
const TIMEOUT_MS = 90_000;
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const fail = (message) => {
  throw new Error(message);
};

const collectCredentialSentinels = (value, key = "") => {
  if (typeof value === "string") return key === "type" || value.length === 0 ? [] : [value];
  if (Array.isArray(value)) return value.flatMap((entry) => collectCredentialSentinels(entry));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([entryKey, entry]) => collectCredentialSentinels(entry, entryKey));
};

const main = async () => {
  const configDirectory = process.env[CONFIG_DIRECTORY];
  if (process.env[OPT_IN] !== "1") {
    fail(`Live provider smoke is disabled. Set ${OPT_IN}=1 to run it explicitly.`);
  }
  if (process.env.CI !== undefined) {
    fail("Live provider smoke refuses to run when CI is set.");
  }
  if (configDirectory === undefined || !isAbsolute(configDirectory)) {
    fail(`${CONFIG_DIRECTORY} must explicitly name an absolute Folio config directory.`);
  }

  const config = JSON.parse(await readFile(join(configDirectory, "config.json"), "utf8"));
  const settings = config?.agent;
  if (settings?.enabled !== true || typeof settings.defaultModelProfileId !== "string") {
    fail("Folio Agent must be enabled with a default model profile.");
  }
  const profile = Array.isArray(settings.modelProfiles)
    ? settings.modelProfiles.find(({ id }) => id === settings.defaultModelProfileId)
    : undefined;
  if (profile === undefined) fail("The default model profile is unavailable.");
  if (profile.credentialSource === "none") {
    fail("Live provider smoke requires a credential-backed default profile.");
  }
  if (rejectsPersonalOpenAiCredential(profile)) {
    fail("Live provider smoke refuses OpenAI and Codex credentials.");
  }

  const providerId = profile.provider?.providerId;
  if (typeof providerId !== "string") fail("The default model provider is invalid.");
  const agentDirectory = process.env[AGENT_DIRECTORY] ?? join(configDirectory, "agent");
  if (!isAbsolute(agentDirectory)) fail(`${AGENT_DIRECTORY} must be absolute when set.`);

  let credentialSentinels = [];
  if (profile.credentialSource === "environment") {
    const variable = profile.environmentVariable;
    const value = typeof variable === "string" ? process.env[variable] : undefined;
    if (value === undefined || value.length === 0) fail("The configured environment credential is missing.");
    credentialSentinels = [value];
  } else if (profile.credentialSource === "managed") {
    const authPath = join(agentDirectory, "auth.json");
    const authInfo = await lstat(authPath);
    if (!authInfo.isFile() || authInfo.isSymbolicLink()) fail("The managed credential store is invalid.");
    const { SecureCredentialStore } = await import("../dist/model/index.js");
    const credential = await new SecureCredentialStore({ authPath }).read(providerId);
    credentialSentinels = collectCredentialSentinels(credential);
    if (credentialSentinels.length === 0) fail("The managed credential is missing or unsupported.");
  } else {
    fail("The default model credential source is invalid.");
  }

  const child = spawn(process.execPath, [resolve(packageDirectory, "dist/cli.js")], {
    cwd: packageDirectory,
    env: {
      ...process.env,
      [CONFIG_DIRECTORY]: configDirectory,
      ...(process.env[AGENT_DIRECTORY] === undefined
        ? {}
        : { [AGENT_DIRECTORY]: process.env[AGENT_DIRECTORY] }),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const exit = new Promise((resolveExit, rejectExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
    child.once("error", rejectExit);
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, TIMEOUT_MS);
  let session;
  let workflowError;
  try {
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout),
    );
    await client().connectWith(stream, async (context) => {
      const initialized = await context.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        info: { name: "folio-agent-live-smoke", version: "0.1.0" },
        capabilities: {},
      });
      if (initialized.protocolVersion !== PROTOCOL_VERSION) fail("ACP v2 initialization failed.");
      session = await context.buildSession(resolve(packageDirectory)).start();
      const accepted = await session.prompt("Reply with exactly OK.");
      if (Object.keys(accepted).length !== 0) fail("Prompt acceptance was not empty.");

      let phase = 0;
      let agentMessageId;
      for (;;) {
        const message = await session.nextUpdate();
        if (message.kind === "stop") {
          if (
            message.stopReason !== "end_turn"
            || message.update.sessionUpdate !== "state_update"
            || message.update.state !== "idle"
            || phase !== 3
          ) {
            fail("Live provider turn did not finish with the required lifecycle.");
          }
          break;
        }
        const update = message.update;
        if (update.sessionUpdate === "user_message" && phase === 0) {
          if (typeof update.messageId !== "string" || update.messageId.length === 0) {
            fail("The user message id is invalid.");
          }
          phase = 1;
        } else if (update.sessionUpdate === "state_update" && update.state === "running" && phase === 1) {
          phase = 2;
        } else if (
          update.sessionUpdate === "agent_message_chunk"
          && update.content.type === "text"
          && update.content.text.length > 0
          && phase >= 2
        ) {
          if (agentMessageId === undefined) agentMessageId = update.messageId;
          if (agentMessageId !== update.messageId) fail("Agent message chunks changed messageId.");
          phase = 3;
        }
      }
      if (agentMessageId === undefined) fail("The provider returned no non-empty agent text.");
      await context.request(methods.agent.session.close, { sessionId: session.sessionId });
      session.dispose();
      session = undefined;
    });
  } catch (error) {
    workflowError = error;
  } finally {
    session?.dispose();
    if (workflowError === undefined && !child.stdin.destroyed) child.stdin.end();
    if (workflowError !== undefined && child.exitCode === null) child.kill("SIGTERM");
  }

  const childExit = await exit;
  clearTimeout(timeout);
  const stdoutText = Buffer.concat(stdout).toString("utf8");
  const stderrText = Buffer.concat(stderr).toString("utf8");
  for (const line of stdoutText.split("\n")) {
    if (line.length === 0) continue;
    try {
      JSON.parse(line);
    } catch {
      fail("folio-agent stdout contained a non-JSON ACP frame.");
    }
  }
  for (const secret of credentialSentinels) {
    if (stdoutText.includes(secret) || stderrText.includes(secret)) {
      fail("A configured credential appeared in process output.");
    }
  }
  credentialSentinels.fill("");

  if (timedOut) fail("Live provider smoke timed out.");
  if (workflowError !== undefined) fail("The live ACP provider workflow failed.");
  if (childExit.code !== 0 || childExit.signal !== null) {
    fail("folio-agent did not exit cleanly after ACP close and stdin EOF.");
  }
};

try {
  await main();
  process.stdout.write("Live provider ACP v2 stdio smoke passed.\n");
} catch {
  process.stderr.write("Live provider ACP v2 stdio smoke failed.\n");
  process.exitCode = 1;
}
