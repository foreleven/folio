import { NodeServices } from "@effect/platform-node";
import { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { Deferred, Effect, Fiber } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { openCodexTurnRuntime, type CodexTurnRuntimeOptions } from "../../src/codex/turn-runtime.js";
import { codexItemId } from "../../src/codex/event-mapper.js";
import { applyToolCallUpdate, type ToolCallSnapshot } from "../../src/acp/tool-upsert.js";

const executable = fileURLToPath(new URL("../fixtures/codex-app-server.mjs", import.meta.url));
const roots: string[] = [];
/** Isolates fixture native state and captures the exact updates the ACP adapter will persist. */
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "folio-codex-turn-"));
  roots.push(cwd);
  const updates: SessionUpdate[] = [];
  return { cwd, updates, onUpdate: async (update: SessionUpdate) => { updates.push(update); } };
}
/** Substitutes only the app-server executable; the transport and Turn state machine are production code. */
const openFixture = (options: CodexTurnRuntimeOptions) => Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* openCodexTurnRuntime(options).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
    ...spawner, spawn: () => spawner.spawn(ChildProcess.make(process.execPath, [executable], {
      cwd: options.cwd, forceKillAfter: "2 seconds",
    })),
  }));
});
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it("waits for both native completion and acknowledgement and replaces streamed output with final items", async () => {
  const input = await fixture();
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const runtime = yield* openFixture(input);
    const first = yield* runtime.prompt("early-completion");
    expect(yield* first.completion).toBe("end_turn");
    expect(yield* runtime.state).toBe("idle");
    const toolId = codexItemId(first.nativeTurnId, "command");
    let tool: ToolCallSnapshot | undefined;
    for (const update of input.updates) {
      if (SessionUpdate.isToolCallUpdate(update) && update.toolCallId === toolId) tool = applyToolCallUpdate(tool, update);
      if (SessionUpdate.isToolCallContentChunk(update) && update.toolCallId === toolId) {
        tool = { ...tool, toolCallId: toolId, content: [...(tool?.content ?? []), update.content] };
      }
    }
    expect(tool?.content).toEqual([{ type: "content", content: { type: "text", text: "one two" } }]);
    expect(input.updates).toContainEqual({ sessionUpdate: "agent_message", messageId: codexItemId(first.nativeTurnId, "message"), _meta: { "folio/messageComplete": true },
      content: [{ type: "text", text: "final answer" }] });
    const second = yield* runtime.prompt("early-completion");
    expect(yield* second.completion).toBe("end_turn");
    expect(second.nativeTurnId).not.toBe(first.nativeTurnId);
    expect(input.updates.filter((update) => SessionUpdate.isStateUpdate(update) && update.state === "idle")).toHaveLength(2);
  })).pipe(Effect.provide(NodeServices.layer)));
});

it("rejects concurrent prompts and cancels even while the start response is pending", async () => {
  const input = await fixture();
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const started = yield* Deferred.make<void>();
    const runtime = yield* openFixture({ ...input, onUpdate: async (update) => {
      input.updates.push(update);
      if (SessionUpdate.isStateUpdate(update) && update.state === "running") await Effect.runPromise(Deferred.succeed(started, undefined));
    } });
    const prompt = yield* runtime.prompt("cancel-start").pipe(Effect.forkScoped);
    yield* Deferred.await(started);
    expect((yield* runtime.prompt("duplicate").pipe(Effect.flip)).reason).toBe("busy");
    yield* runtime.cancel;
    const handle = yield* Fiber.join(prompt);
    expect(yield* handle.completion).toBe("cancelled");
    expect(yield* runtime.state).toBe("idle");
    expect(input.updates.at(-1)).toMatchObject({ state: "idle", stopReason: "cancelled" });
  })).pipe(Effect.provide(NodeServices.layer)));
  expect(JSON.parse(await readFile(join(input.cwd, "interrupt.json"), "utf8"))).toEqual({ threadId: "native-thread", turnId: "turn-1" });
});

it.each([["crash", "connection_failed"], ["unsupported", "unsupported_request"]] as const)(
  "fails the Run and closes the Session on %s", async (mode, reason) => {
    const input = await fixture();
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* openFixture(input);
      const error = yield* runtime.prompt(mode).pipe(Effect.flatMap((handle) => handle.completion), Effect.flip);
      expect(error.reason).toBe(reason);
      expect(input.updates.at(-1)).toMatchObject({ _meta: { "folio/executionInterrupted": true } });
      expect(yield* runtime.state).toBe("closed");
      expect((yield* runtime.prompt("retry").pipe(Effect.flip)).reason).toBe(reason);
    })).pipe(Effect.provide(NodeServices.layer)));
  },
);

it("does not report success if the completed Turn and acknowledgement have different IDs", async () => {
  const input = await fixture();
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const runtime = yield* openFixture(input);
    expect((yield* runtime.prompt("mismatch").pipe(Effect.flip)).reason).toBe("protocol_error");
    expect(input.updates).not.toContainEqual({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
  })).pipe(Effect.provide(NodeServices.layer)));
});

it("preserves native execution failure and allows a subsequent prompt", async () => {
  const input = await fixture();
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const runtime = yield* openFixture(input);
    const run = yield* runtime.prompt("failed");
    expect(yield* run.completion).toBe("failed");
    expect(input.updates.at(-1)).toMatchObject({ state: "idle", stopReason: "refusal" });
    expect(input.updates.at(-1)?._meta ?? {}).not.toHaveProperty("folio/executionInterrupted");
    expect(yield* runtime.state).toBe("idle");
  })).pipe(Effect.provide(NodeServices.layer)));
});

it("stops execution if the output sink fails", async () => {
  const input = await fixture();
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const runtime = yield* openFixture({ ...input, onUpdate: async (update) => {
      if (SessionUpdate.isAgentMessage(update)) throw new Error("sink unavailable");
    } });
    const error = yield* runtime.prompt("output-failure").pipe(Effect.flatMap((run) => run.completion), Effect.flip);
    expect(error.reason).toBe("output_failed");
    expect(yield* runtime.state).toBe("closed");
  })).pipe(Effect.provide(NodeServices.layer)));
});

it("terminates a native process that acknowledges interrupt but never completes the Turn", async () => {
  const input = await fixture();
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const runtime = yield* openFixture({ ...input, requestTimeoutMs: 500 });
    const run = yield* runtime.prompt("cancel-timeout");
    expect((yield* runtime.cancel.pipe(Effect.flip)).reason).toBe("cancel_timeout");
    expect((yield* run.completion.pipe(Effect.flip)).reason).toBe("cancel_timeout");
    expect(yield* runtime.state).toBe("closed");
  })).pipe(Effect.provide(NodeServices.layer)));
});

it("retains execution ownership until the final ACP update has been persisted", async () => {
  const input = await fixture();
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const finishing = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const runtime = yield* openFixture({ ...input, onUpdate: async (update) => {
      if (SessionUpdate.isStateUpdate(update) && update.state === "idle" && update.stopReason === "end_turn") {
        await Effect.runPromise(Deferred.succeed(finishing, undefined));
        await Effect.runPromise(Deferred.await(release));
      }
      input.updates.push(update);
    } });
    const prompt = yield* runtime.prompt("early-completion").pipe(Effect.forkScoped);
    yield* Deferred.await(finishing);
    expect((yield* runtime.prompt("too early").pipe(Effect.flip)).reason).toBe("busy");
    yield* Deferred.succeed(release, undefined);
    const handle = yield* Fiber.join(prompt);
    expect(yield* handle.completion).toBe("end_turn");
    expect(yield* runtime.state).toBe("idle");
  })).pipe(Effect.provide(NodeServices.layer)));
});

it("coalesces concurrent cancellation calls and closes an active Turn when its Scope ends", async () => {
  const input = await fixture();
  const completion = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const runtime = yield* openFixture(input);
    const first = yield* runtime.prompt("running");
    yield* Effect.all([runtime.cancel, runtime.cancel], { concurrency: "unbounded" });
    expect(yield* first.completion).toBe("cancelled");
    const second = yield* runtime.prompt("running");
    return second.completion;
  })).pipe(Effect.provide(NodeServices.layer)));
  expect((await Effect.runPromise(Effect.flip(completion))).reason).toBe("closed");
});


it.each(["early-completion", "cleanup-error", "cleanup-delay"])("closes the native owner after attempting terminal cleanup (%s)", async mode => {
  const input = await fixture();
  let pid = 0;
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const runtime = yield* openFixture(input);
    pid = runtime.processId;
    const turn = yield* runtime.prompt(mode);
    expect(yield* turn.completion).toBe("end_turn");
    const closing = yield* runtime.close.pipe(Effect.forkScoped);
    yield* Effect.sleep("10 millis");
    // A second caller must await the first cleanup, even though state is already terminal.
    yield* runtime.close;
    expect(yield* runtime.state).toBe("closed");
    expect(() => process.kill(pid, 0)).toThrow();
    yield* Fiber.join(closing);
    expect((yield* runtime.prompt("must-not-replay").pipe(Effect.flip)).reason).toBe("closed");
  })).pipe(Effect.provide(NodeServices.layer)));
  expect(JSON.parse(await readFile(join(input.cwd, "terminal-cleanup.json"), "utf8")))
    .toEqual({ threadId: "native-thread" });
  expect(() => process.kill(pid, 0)).toThrow();
});
