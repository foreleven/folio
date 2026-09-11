#!/usr/bin/env node
import { ndJsonStream } from "@agentclientprotocol/sdk/experimental/v2";
import { Effect, Schema } from "effect";
import { Readable, Writable } from "node:stream";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { SessionArchive } from "./acp/session-archive.js";
import { createFolioAgentApp, type FolioAgentApp } from "./acp/server.js";
import { AgentConfigLoadError, loadFolioAgentConfig } from "./config/loader.js";
import { resolveFolioSessionStorageDirectory } from "./config/directory.js";
import { makeFolioAgentRuntimeComposition } from "./runtime/composition.js";
import { makeCodexAcpBackend } from "./codex/acp-backend.js";
import { resolveSessionSkillPaths } from "./config/session-skills.js";

const AgentKind = Schema.Literals(["pi", "codex"]);
let selected: typeof AgentKind.Type | undefined;
try {
  const { values } = parseArgs({ options: { agent: { type: "string", default: "pi" } }, allowPositionals: false });
  selected = Schema.decodeUnknownSync(AgentKind)(values.agent);
} catch {
  process.stderr.write("Usage: folio-agent [--agent pi|codex]\n");
  process.exitCode = 1;
}

let app: FolioAgentApp | undefined;
let dispose = async (): Promise<void> => {};
if (selected !== undefined) {
  try {
    const storageDirectory = resolveFolioSessionStorageDirectory();
    const skillPaths = await resolveSessionSkillPaths(process.env.FOLIO_SESSION_SKILL_PATHS);
    if (selected === "codex") {
      // Codex uses its local installation/auth; a Pi model profile is not a prerequisite.
      app = createFolioAgentApp({
        backendFactory: makeCodexAcpBackend({ executable: process.env.FOLIO_CODEX_EXECUTABLE, skillPaths }),
        archive: new SessionArchive(join(storageDirectory, "acp-sessions")),
      });
    } else {
      const snapshot = await Effect.runPromise(loadFolioAgentConfig());
      if (snapshot.defaultProfile !== undefined) {
        process.stderr.write(`default model loaded ${snapshot.defaultProfile.provider.providerId}/${snapshot.defaultProfile.modelId}\n`);
      }
      const runtimeDirectory = process.env.FOLIO_SESSION_RUNTIME_DIR || undefined;
      if (runtimeDirectory !== undefined && !isAbsolute(runtimeDirectory)) throw new Error("invalid runtime directory");
      if (process.env.FOLIO_SESSION_MODEL_PROFILE && runtimeDirectory === undefined) throw new Error("missing runtime directory");
      const composition = makeFolioAgentRuntimeComposition(snapshot, {
        sessionDirectory: join(storageDirectory, "sessions"), runtimeDirectory, skillPaths,
      });
      dispose = composition.shutdown;
      app = createFolioAgentApp({
        sessionFactory: composition.sessionFactory,
        archive: new SessionArchive(join(storageDirectory, "acp-sessions")),
      });
    }
  } catch (error) {
    process.stderr.write(`${error instanceof AgentConfigLoadError ? error.message : "Agent configuration is unavailable."}\n`);
    process.exitCode = 1;
  }
}

if (app !== undefined) {
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const connection = app.connect(ndJsonStream(output, input));
  const close = (): void => connection.close();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try { await connection.closed; }
  finally {
    process.removeListener("SIGINT", close);
    process.removeListener("SIGTERM", close);
    try { await app.shutdown(); } finally { await dispose(); }
  }
}
