import { client, methods, PROTOCOL_VERSION, type SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { Effect, Schema } from "effect";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionArchive } from "../src/acp/session-archive.js";
import { createFolioAgentApp } from "../src/acp/server.js";
import { makeFakePiSessionFactory } from "../src/pi/fake-session-factory.js";
import { openPiSessionStorage, PiSessionIdentity } from "../src/pi/session-storage.js";
import type { PiSessionFactory } from "../src/pi/session-factory.js";

const roots: string[] = [];

/** Uses a fake model but the production native storage and ACP archive, without provider requests. */
function factory(directory: string): PiSessionFactory {
  const fake = makeFakePiSessionFactory();
  return { create: (cwd, resume) => Effect.gen(function*() {
    const manager = yield* openPiSessionStorage({ cwd, directory, resume }).pipe(Effect.orDie);
    const session = yield* fake.create(cwd);
    Object.defineProperty(session, "sessionManager", { value: manager });
    return session;
  }) };
}

/** Creates a stable directory reused by separate protocol server instances. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "folio-acp-archive-"));
  roots.push(root);
  const archive = new SessionArchive(join(root, "archive"));
  const sessionFactory = factory(join(root, "native"));
  return { root, archive, sessionFactory, cwd: join(root, "task") };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ACP persisted session archive", () => {
  it("reads replay only after acquiring ownership, including the preceding owner's final update", async () => {
    const { archive, sessionFactory, cwd } = await fixture();
    const first = createFolioAgentApp({ archive, sessionFactory, log: () => undefined });
    let sessionId = "";
    await client().connectWith(first, async context => {
      await context.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, info: { name: "test", version: "1" }, capabilities: {} });
      sessionId = (await context.request(methods.agent.session.new, { cwd })).sessionId;
    });
    await first.shutdown();
    const lastUpdate: SessionUpdate = { sessionUpdate: "user_message", messageId: "last-before-release", content: [{ type: "text", text: "retained" }] };
    const acquire = archive.leases.acquire.bind(archive.leases);
    const spy = vi.spyOn(archive.leases, "acquire").mockImplementationOnce(async (...args) => {
      // The previous writer finishes between header lookup and the new lease.
      await archive.append(sessionId, lastUpdate);
      return acquire(...args);
    });
    const second = createFolioAgentApp({ archive, sessionFactory, log: () => undefined });
    const replay: SessionUpdate[] = [];
    try {
      await client().onNotification(methods.client.session.update, ({ params }) => { replay.push(params.update); }).connectWith(second, async context => {
        await context.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, info: { name: "test", version: "1" }, capabilities: {} });
        await context.request(methods.agent.session.resume, { sessionId, cwd, replayFrom: { type: "start" } });
        expect(replay).toEqual([lastUpdate]);
      });
    } finally { spy.mockRestore(); await second.shutdown(); }
  });

  it("rejects missing native history instead of replacing the archived identity", async () => {
    const { archive, sessionFactory, cwd } = await fixture();
    const first = createFolioAgentApp({ archive, sessionFactory, log: () => undefined });
    let id = "";
    await client().connectWith(first, async (context) => {
      await context.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, info: { name: "test", version: "1" }, capabilities: {} });
      id = (await context.request(methods.agent.session.new, { cwd })).sessionId;
    });
    await first.shutdown();
    const before = await archive.read(id);
    await rm(Schema.decodeUnknownSync(PiSessionIdentity)(before.header.native).nativeSessionFile);
    const second = createFolioAgentApp({ archive, sessionFactory, log: () => undefined });
    await client().connectWith(second, async (context) => {
      await context.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, info: { name: "test", version: "1" }, capabilities: {} });
      await expect(context.request(methods.agent.session.resume, { sessionId: id, cwd })).rejects.toBeDefined();
    });
    await second.shutdown();
    expect((await archive.read(id)).header).toEqual(before.header);
  });

  it("preserves ACP/native identities and exact replay updates across server instances", async () => {
    const { archive, sessionFactory, cwd } = await fixture();
    const first = createFolioAgentApp({ archive, sessionFactory, log: () => undefined });
    let sessionId = "";
    const original: SessionUpdate[] = [];
    const positions: unknown[] = [];
    await client().onNotification(methods.client.session.update, ({ params }) => {
      positions.push(params._meta?.['folio/eventSequence']);
    }).connectWith(first, async (context) => {
      await context.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, info: { name: "test", version: "1" }, capabilities: {} });
      const session = await context.buildSession(cwd).start();
      sessionId = session.sessionId;
      await session.prompt("hello");
      while (true) {
        const { update } = await session.nextUpdate();
        original.push(update);
        if (update.sessionUpdate === "state_update" && update.state === "idle") break;
      }
    });
    await first.shutdown();
    const stored = await archive.read(sessionId);
    expect(stored.header.native.nativeSessionId).not.toBe(sessionId);
    expect(stored.history).toEqual(original);
    expect(positions).toEqual(original.map((_, index) => index + 1));
    expect(await readFile(Schema.decodeUnknownSync(PiSessionIdentity)(stored.header.native).nativeSessionFile, "utf8")).toContain(stored.header.native.nativeSessionId);

    const replay: SessionUpdate[] = [];
    const replayPositions: unknown[] = [];
    const second = createFolioAgentApp({ archive, sessionFactory, log: () => undefined });
    const reader = client().onNotification(methods.client.session.update, ({ params }) => {
      replay.push(params.update);
      replayPositions.push(params._meta?.['folio/eventSequence']);
    });
    await reader.connectWith(second, async (context) => {
      await context.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, info: { name: "test", version: "1" }, capabilities: {} });
      const listed = await context.request(methods.agent.session.list, {});
      expect(listed.sessions.map((session) => session.sessionId)).toContain(sessionId);
      await context.request(methods.agent.session.resume, { sessionId, cwd, replayFrom: { type: "start" } });
      expect(replay).toEqual(original);
      expect(replayPositions).toEqual(positions);
      await context.request(methods.agent.session.close, { sessionId });
    });
    await second.shutdown();
    expect((await archive.read(sessionId)).history).toEqual(original);
    expect((await archive.list()).map((session) => session.sessionId)).toContain(sessionId);
  });

  it("serializes event writes and refuses truncated history without repairing or leaking it", async () => {
    const { archive, root } = await fixture();
    await archive.create({ version: 1, sessionId: "one", cwd: root,
      native: { nativeSessionId: "native", nativeSessionFile: join(root, "native.jsonl") }, createdAt: new Date().toISOString() });
    await Promise.all(["one", "two"].map((text) => archive.append("one", {
      sessionUpdate: "agent_message_chunk", messageId: "assistant", content: { type: "text", text },
    })));
    expect((await archive.read("one")).history).toMatchObject([
      { content: { text: "one" } }, { content: { text: "two" } },
    ]);
    const path = join(root, "archive", "one", "updates.jsonl");
    await appendFile(path, '{"private-secret":');
    expect((await archive.readHeader("one")).native.nativeSessionId).toBe("native");
    await expect(archive.read("one")).rejects.toMatchObject({ message: "The ACP session archive is unavailable or invalid." });
    expect(await readFile(path, "utf8")).toContain('"private-secret"');
  });

  it("restores an interrupted session as idle without replaying its prompt to the model", async () => {
    const { archive, sessionFactory, cwd, root } = await fixture();
    const manager = await Effect.runPromise(openPiSessionStorage({ cwd, directory: join(root, "native") }));
    await archive.create({ version: 1, sessionId: "interrupted", cwd, createdAt: new Date().toISOString(),
      native: { nativeSessionId: manager.getSessionId(), nativeSessionFile: manager.getSessionFile()! } });
    await archive.append("interrupted", { sessionUpdate: "state_update", state: "running" });
    const refused = createFolioAgentApp({ archive, sessionFactory, log: () => undefined });
    await client().connectWith(refused, async context => {
      await context.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, info: { name: "test", version: "1" }, capabilities: {} });
      await expect(context.request(methods.agent.session.resume, { sessionId: "interrupted", cwd, replayFrom: { type: "start" } })).rejects.toThrow();
    });
    await refused.shutdown();
    // A stopped execution retains its coordination database. Merely copying a history file
    // without that ownership evidence must not authorize an Agent resume.
    const receipt = await archive.leases.acquire("interrupted");
    await receipt.release();
    const updates: SessionUpdate[] = [];
    const app = createFolioAgentApp({ archive, sessionFactory, log: () => undefined });
    await client().onNotification(methods.client.session.update, ({ params }) => { updates.push(params.update); }).connectWith(app, async (context) => {
      await context.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, info: { name: "test", version: "1" }, capabilities: {} });
      await context.request(methods.agent.session.resume, { sessionId: "interrupted", cwd, replayFrom: { type: "start" } });
    });
    await app.shutdown();
    expect(updates).toEqual([
      { sessionUpdate: "state_update", state: "running" },
      { sessionUpdate: "state_update", state: "idle", stopReason: "cancelled" },
    ]);
  });
});
