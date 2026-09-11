import { client, methods, PROTOCOL_VERSION, type SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { Effect } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createFolioAgentApp } from "../src/acp/server.js";
import { SessionArchive } from "../src/acp/session-archive.js";
import { makeCodexAcpBackend } from "../src/codex/acp-backend.js";
import { openCodexTurnRuntime } from "../src/codex/turn-runtime.js";

const executable = fileURLToPath(new URL("./fixtures/codex-app-server.mjs", import.meta.url));
const roots: string[] = [];
/** Uses the real ACP shell, backend, Scope and subprocess transport with deterministic native events. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "folio-codex-acp-"));
  roots.push(root);
  const pids: number[] = [];
  const backendFactory = makeCodexAcpBackend({ acquire: (options) => Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* openCodexTurnRuntime(options).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
      ...spawner, spawn: () => spawner.spawn(ChildProcess.make(process.execPath, [executable], {
        cwd: options.cwd, forceKillAfter: "2 seconds",
      })).pipe(Effect.tap((child) => Effect.sync(() => { pids.push(child.pid); }))),
    }));
  }) });
  return { root, pids, backendFactory, archive: new SessionArchive(join(root, "archive")), log: () => undefined };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const initialization = { protocolVersion: PROTOCOL_VERSION, info: { name: "test", version: "1" }, capabilities: {} };

it("runs multiple Codex turns through ACP, then restores exact replay with the same native identity in a new process", async () => {
  const input = await fixture();
  const first = createFolioAgentApp(input);
  let id = "";
  const original: SessionUpdate[] = [];
  try {
    await client().connectWith(first, async (context) => {
      await context.request(methods.agent.initialize, initialization);
      const session = await context.buildSession(input.root).start();
      id = session.sessionId;
      for (let i = 0; i < 2; i++) {
        await session.prompt("early-completion");
        while (true) {
          const { update } = await session.nextUpdate();
          original.push(update);
          if (update.sessionUpdate === "state_update" && update.state === "idle") break;
        }
      }
      expect(input.pids).toHaveLength(1);
      await expect(context.request(methods.agent.session.setConfigOption, {
        sessionId: id, configId: "model", type: "id", value: "not-wired",
      })).rejects.toThrow("Codex configuration controls are not available.");
    });
  } finally { await first.shutdown(); }
  expect(() => process.kill(input.pids[0]!, 0)).toThrow();
  const stored = await input.archive.read(id);
  expect(stored.header.native).toEqual({ agent: "codex", nativeSessionId: "native-thread" });
  expect(stored.history).toEqual(original);
  const replay: SessionUpdate[] = [];
  const second = createFolioAgentApp(input);
  try {
    await client().onNotification(methods.client.session.update, ({ params }) => { replay.push(params.update); }).connectWith(second, async (context) => {
      await context.request(methods.agent.initialize, initialization);
      const listed = await context.request(methods.agent.session.list, {});
      expect(listed.sessions).toMatchObject([{ sessionId: id, _meta: { "folio/nativeSessionId": "native-thread" } }]);
      const resumed = await context.request(methods.agent.session.resume, { sessionId: id, cwd: input.root, replayFrom: { type: "start" } });
      expect(resumed._meta).toEqual({ "folio/nativeSessionId": "native-thread" });
      expect(replay).toEqual(original);
      expect(input.pids).toHaveLength(2);
      await context.request(methods.agent.session.close, { sessionId: id });
    });
  } finally { await second.shutdown(); }
  expect(() => process.kill(input.pids[1]!, 0)).toThrow();
  expect((await input.archive.read(id)).history).toEqual(original);
});

it("never lists or resumes a Codex archive as a Pi session", async () => {
  const input = await fixture();
  await input.archive.create({ version: 1, sessionId: "codex", cwd: input.root,
    native: { agent: "codex", nativeSessionId: "native-thread" }, createdAt: new Date().toISOString() });
  const pi = createFolioAgentApp({ archive: input.archive, log: () => undefined });
  try {
    await client().connectWith(pi, async (context) => {
      await context.request(methods.agent.initialize, initialization);
      expect((await context.request(methods.agent.session.list, {})).sessions).toEqual([]);
      await expect(context.request(methods.agent.session.resume, { sessionId: "codex", cwd: input.root }))
        .rejects.toThrow("The session belongs to another Agent.");
    });
  } finally { await pi.shutdown(); }
  expect((await input.archive.read("codex")).header.native).toEqual({ agent: "codex", nativeSessionId: "native-thread" });
});

it("waits for in-flight creation during shutdown and does not leak its native process", async () => {
  const input = await fixture();
  let release!: () => void;
  let opened!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { opened = resolve; });
  const app = createFolioAgentApp({ ...input, backendFactory: { agent: "codex", create: async (options) => {
    const backend = await input.backendFactory.create(options);
    opened();
    await gate;
    return backend;
  } } });
  await client().connectWith(app, async (context) => {
    await context.request(methods.agent.initialize, initialization);
    const pending = context.request(methods.agent.session.new, { cwd: input.root });
    // Attach the rejection observer before shutdown can reject the pending request.
    const rejected = expect(pending).rejects.toThrow("Agent is shutting down.");
    await started;
    const closed = app.shutdown();
    release();
    await closed;
    await rejected;
  });
  await app.shutdown();
  expect(input.pids).toHaveLength(1);
  expect(() => process.kill(input.pids[0]!, 0)).toThrow();
});

it("cancels through ACP and accepts the next prompt after the idle notification", async () => {
  const input = await fixture();
  const app = createFolioAgentApp(input);
  const observed: SessionUpdate[] = [];
  let id = "";
  try {
    await client().connectWith(app, async (context) => {
      await context.request(methods.agent.initialize, initialization);
      const session = await context.buildSession(input.root).start();
      id = session.sessionId;
      await session.prompt("running");
      await context.notify(methods.agent.session.cancel, { sessionId: id });
      for (const expected of ["cancelled", "end_turn"]) {
        if (expected === "end_turn") await session.prompt("early-completion");
        while (true) {
          const { update } = await session.nextUpdate();
          observed.push(update);
          if (update.sessionUpdate === "state_update" && update.state === "idle") {
            expect(update).toMatchObject({ stopReason: expected });
            break;
          }
        }
      }
      expect(input.pids).toHaveLength(1);
    });
  } finally { await app.shutdown(); }
  expect((await input.archive.read(id)).history).toEqual(observed);
});
