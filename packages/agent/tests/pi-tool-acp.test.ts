import { client, methods, PROTOCOL_VERSION, SessionUpdate, ToolCallContent, ContentBlock } from "@agentclientprotocol/sdk/experimental/v2";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { makePiSessionFactory } from "../src/pi/session-factory.js";
import { createFolioAgentApp } from "../src/acp/server.js";
import { SessionArchive } from "../src/acp/session-archive.js";
import { applyToolCallUpdate, type ToolCallSnapshot } from "../src/acp/tool-upsert.js";

/** Replaces only provider output; Pi still runs its real prompt loop, tools and native persistence. */
function response(toolCall?: ToolCall, aborted = false) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant", api: "openai-completions", provider: "openai", model: "gpt-4o",
    timestamp: Date.now(), content: toolCall ? [toolCall] : [{ type: "text", text: "Finished" }],
    stopReason: aborted ? "aborted" : toolCall ? "toolUse" : "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  if (aborted) {
    stream.push({ type: "error", reason: "aborted", error: message });
    return stream;
  }
  stream.push({ type: "start", partial: message });
  if (toolCall) stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
  else stream.push({ type: "text_delta", contentIndex: 0, delta: "Finished", partial: message });
  stream.push({ type: "done", reason: toolCall ? "toolUse" : "stop", message });
  return stream;
}

/** Projects both append chunks and replacement updates using the ACP semantics used by clients. */
function project(updates: SessionUpdate[]) {
  const calls = new Map<string, ToolCallSnapshot>();
  for (const update of updates) {
    if (SessionUpdate.isToolCallUpdate(update)) {
      calls.set(update.toolCallId, applyToolCallUpdate(calls.get(update.toolCallId), update));
    } else if (SessionUpdate.isToolCallContentChunk(update)) {
      const prior = calls.get(update.toolCallId);
      calls.set(update.toolCallId, { ...prior, toolCallId: update.toolCallId,
        content: [...(prior?.content ?? []), update.content] });
    }
  }
  return calls;
}

it("executes a real Pi tool loop through ACP and replays its exact persisted tool output", async () => {
  const root = await mkdtemp(join(tmpdir(), "folio-pi-tool-acp-"));
  const cwd = join(root, "task");
  await mkdir(cwd);
  const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
  await runtime.setRuntimeApiKey("openai", "test-only-unused-key");
  const model = runtime.getModel("openai", "gpt-4o")!;
  expect(model).toBeDefined();
  const script: Array<ToolCall | undefined> = [
    { type: "toolCall", id: "write-page", name: "write", arguments: { path: "wiki/page.md", content: "saved" } },
    { type: "toolCall", id: "shell-output", name: "bash", arguments: { command: "printf 'first\\n'; sleep 0.15; printf 'second\\n'" } },
    { type: "toolCall", id: "shell-failure", name: "bash", arguments: { command: "exit 7" } },
    undefined,
    { type: "toolCall", id: "shell-cancel", name: "bash", arguments: { command: "echo $$; exec sleep 30" } },
  ];
  let requests = 0;
  const factory = makePiSessionFactory({
    agentDirectory: join(root, "agent"), modelRuntime: runtime,
    profile: { profileId: "test", model, thinkingLevel: "off" },
    createAgentSession: async (options) => {
      const result = await createAgentSession(options);
      result.session.agent.streamFunction = (_model, _context, streamOptions) =>
        streamOptions?.signal?.aborted ? response(undefined, true) : response(script[requests++]);
      return result;
    },
  });
  const archive = new SessionArchive(join(root, "archive"));
  const first = createFolioAgentApp({ sessionFactory: factory, archive, log: () => undefined });
  const updates: SessionUpdate[] = [];
  let id = "";
  try {
    await client().connectWith(first, async (context) => {
      await context.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, info: { name: "test", version: "1" }, capabilities: {} });
      const session = await context.buildSession(cwd).start();
      id = session.sessionId;
      await session.prompt("Execute the fixture task");
      while (true) {
        const { update } = await session.nextUpdate();
        updates.push(update);
        if (update.sessionUpdate === "state_update" && update.state === "idle") break;
      }
      expect(requests).toBe(4);
      await session.prompt("Start the cancellable fixture");
      let cancelledPid: number | undefined;
      while (true) {
        const { update } = await session.nextUpdate();
        updates.push(update);
        if (SessionUpdate.isToolCallUpdate(update) && update.toolCallId === "shell-cancel" && cancelledPid === undefined) {
          const first = update.content?.[0];
          if (first !== undefined && ToolCallContent.isContent(first) && ContentBlock.isText(first.content) && /^\d+\s*$/.test(first.content.text)) {
            cancelledPid = Number(first.content.text.trim());
            expect(() => process.kill(cancelledPid!, 0)).not.toThrow();
            await context.notify(methods.agent.session.cancel, { sessionId: id });
          }
        }
        if (update.sessionUpdate === "state_update" && update.state === "idle") {
          expect(update).toMatchObject({ stopReason: "cancelled" });
          break;
        }
      }
      expect(cancelledPid).toBeDefined();
      // Idle must mean the native Shell process has actually exited, not just hidden from the UI.
      expect(() => process.kill(cancelledPid!, 0)).toThrow();
    });
    await first.shutdown();
    expect(requests).toBe(5);
    expect(await readFile(join(cwd, "wiki/page.md"), "utf8")).toBe("saved");
    const calls = project(updates);
    expect(calls.get("write-page")?.status).toBe("completed");
    expect(calls.get("shell-failure")?.status).toBe("failed");
    expect(calls.get("shell-output")?.content).toEqual([
      { type: "content", content: { type: "text", text: "first\nsecond\n" } },
    ]);
    expect((await archive.read(id)).history).toEqual(updates);
    const replay: SessionUpdate[] = [];
    const second = createFolioAgentApp({ sessionFactory: factory, archive, log: () => undefined });
    try {
      await client().onNotification(methods.client.session.update, ({ params }) => { replay.push(params.update); })
        .connectWith(second, async (context) => {
          await context.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, info: { name: "test", version: "1" }, capabilities: {} });
          await context.request(methods.agent.session.resume, { sessionId: id, cwd, replayFrom: { type: "start" } });
        });
      expect(replay).toEqual(updates);
      expect(project(replay)).toEqual(calls);
      expect(requests).toBe(5);
    } finally { await second.shutdown(); }
  } finally {
    await first.shutdown();
    await runtime.removeRuntimeApiKey("openai");
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
