import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import { openCodexConnection } from "../dist/codex/connection.js";
import { promisify } from "node:util";

const execute = promisify(execFile);
const executable = process.env.FOLIO_CODEX_EXECUTABLE || "codex";
const directory = await mkdtemp(join(tmpdir(), "folio-codex-protocol-"));

/** Finds a generated public protocol schema without assuming the CLI's output directory layout. */
async function findSchema(root, filename) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === filename) return path;
    if (entry.isDirectory()) {
      const found = await findSchema(path, filename);
      if (found) return found;
    }
  }
  return undefined;
}

/** Exercises the production scoped transport without creating a thread or sending a prompt. */
async function handshake() {
  let pid;
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const connection = yield* openCodexConnection({ executable, cwd: directory });
    pid = connection.pid;
    yield* connection.request("model/list", { limit: 1 }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ data: Schema.Array(Schema.Unknown) }))),
    );
  })).pipe(Effect.provide(NodeServices.layer)));
  assert.ok(pid, "Missing child process identity");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  return { transport: "stdio", initialize: "passed", modelList: "passed", processCleanup: "passed",
    implementation: "production CodexConnection", nativeProtocol: "Codex app-server (not ACP)" };
}

try {
  const version = (await execute(executable, ["--version"])).stdout.trim();
  await execute(executable, ["app-server", "generate-json-schema", "--out", directory]);
  const requirements = {
    "ThreadStartParams.json": ["cwd", "sandbox", "approvalPolicy", "ephemeral"],
    "ThreadResumeParams.json": ["threadId", "cwd"],
    "TurnStartParams.json": ["threadId", "input"],
    "TurnInterruptParams.json": ["threadId", "turnId"],
  };
  const schemas = [];
  for (const [filename, properties] of Object.entries(requirements)) {
    const path = await findSchema(directory, filename);
    assert.ok(path, `Missing ${filename}`);
    const content = await readFile(path, "utf8");
    const schema = JSON.parse(content);
    for (const property of properties) assert.ok(schema.properties[property], `${filename} lacks ${property}`);
    schemas.push({ filename, sha256: createHash("sha256").update(content).digest("hex"), properties });
  }
  console.log(JSON.stringify({
    version, schemas, handshake: await handshake(),
    notVerified: ["ACP adapter", "model execution", "tool execution", "cancellation", "native resume", "full access"],
  }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
