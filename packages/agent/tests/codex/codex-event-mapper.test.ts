import { Effect } from "effect";
import { expect, it } from "vitest";
import { codexItemId, mapCodexEvent } from "../../src/codex/event-mapper.js";

it("projects native file changes, failed commands and final reasoning without inventing patch formats", async () => {
  const file = await Effect.runPromise(mapCodexEvent({ method: "item/completed", params: {
    threadId: "thread", turnId: "turn", item: { id: "file", type: "fileChange", status: "completed",
      changes: [{ path: "/work/wiki/page.md", diff: "@@ -1 +1 @@\n-old\n+new" }] },
  } }));
  expect(file).toEqual([{ sessionUpdate: "tool_call_update", toolCallId: codexItemId("turn", "file"), title: "Edit files",
    kind: "edit", status: "completed", locations: [{ path: "/work/wiki/page.md" }],
    content: [{ type: "content", content: { type: "text", text: "/work/wiki/page.md\n@@ -1 +1 @@\n-old\n+new" } }],
  }]);
  const command = await Effect.runPromise(mapCodexEvent({ method: "item/completed", params: {
    threadId: "thread", turnId: "turn", item: { id: "command", type: "commandExecution", command: "exit 1", cwd: "/work",
      status: "failed", aggregatedOutput: "" },
  } }));
  expect(command[0]).toMatchObject({ status: "failed", content: [{ type: "content", content: { text: "" } }] });
  const thought = await Effect.runPromise(mapCodexEvent({ method: "item/completed", params: {
    threadId: "thread", turnId: "turn", item: { id: "thought", type: "reasoning", summary: ["Summary"], content: ["Native content"] },
  } }));
  expect(thought).toEqual([{ sessionUpdate: "agent_thought", messageId: codexItemId("turn", "thought"), _meta: { "folio/messageComplete": true },
    content: [{ type: "text", text: "Summary" }] }]);
});

it("rejects malformed known events without exposing their contents, and tolerates unknown native display types", async () => {
  const error = await Effect.runPromise(Effect.flip(mapCodexEvent({ method: "item/agentMessage/delta", params: {
    threadId: "thread", turnId: "turn", itemId: "message", delta: { secret: "private-sentinel" },
  } })));
  expect(error.message).toBe("Codex emitted an invalid display event.");
  expect(JSON.stringify(error)).not.toContain("private-sentinel");
  expect(await Effect.runPromise(mapCodexEvent({ method: "item/completed", params: {
    threadId: "thread", turnId: "turn", item: { id: "unknown", type: "futureItem", payload: "opaque" },
  } }))).toEqual([]);
});
