import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { applyToolCallUpdate } from "../src/acp/tool-upsert.js";
import { acquirePiSession } from "../src/pi/session.js";

describe("M0 protocol helpers", () => {
  it("applies tool upsert omitted, null, and value semantics", () => {
    const first = applyToolCallUpdate(undefined, {
      toolCallId: "tool-1",
      name: "read",
      title: "Read file",
      status: "pending",
    });
    const omitted = applyToolCallUpdate(first, {
      toolCallId: "tool-1",
      status: "in_progress",
    });
    const cleared = applyToolCallUpdate(omitted, {
      toolCallId: "tool-1",
      title: null,
      status: "completed",
      content: [],
    });

    expect(omitted).toMatchObject({ name: "read", title: "Read file", status: "in_progress" });
    expect(cleared).toEqual({
      toolCallId: "tool-1",
      name: "read",
      title: undefined,
      status: "completed",
      content: [],
      rawInput: undefined,
      rawOutput: undefined,
    });
  });

  it("aborts active Pi work before scoped disposal", async () => {
    const events: string[] = [];
    const session = {
      isIdle: false,
      abort: vi.fn(async () => {
        events.push("abort");
      }),
      dispose: vi.fn(() => {
        events.push("dispose");
      }),
    };

    await Effect.runPromise(
      Effect.scoped(acquirePiSession(Effect.succeed(session))),
    );

    expect(events).toEqual(["abort", "dispose"]);
    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
  });
});
