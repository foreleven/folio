import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { makePiEventMapper } from "../src/pi/event-mapper.js";

const event = (value: unknown): AgentSessionEvent => value as AgentSessionEvent;

const assistantMessage = {
  role: "assistant",
  content: [],
  api: "openai-completions",
  provider: "test-provider",
  model: "test-model",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop",
  timestamp: 0,
};

describe("Pi AgentSessionEvent to ACP v2 mapper", () => {
  it("keeps one agent-owned message ID for each streamed assistant message", () => {
    let nextId = 0;
    const mapper = makePiEventMapper({ createMessageId: () => `message-${++nextId}` });

    expect(mapper.map(event({ type: "message_start", message: assistantMessage }))).toEqual([]);
    const first = mapper.map(event({
      type: "message_update",
      message: assistantMessage,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello", partial: assistantMessage },
    }));
    const second = mapper.map(event({
      type: "message_update",
      message: assistantMessage,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " world", partial: assistantMessage },
    }));
    expect(mapper.map(event({ type: "message_end", message: assistantMessage }))).toEqual([{
      sessionUpdate: "agent_message", messageId: "message-1", _meta: { "folio/messageComplete": true },
    }]);
    const next = mapper.map(event({
      type: "message_update",
      message: assistantMessage,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "next", partial: assistantMessage },
    }));

    expect(first).toEqual([{
      sessionUpdate: "agent_message_chunk",
      messageId: "message-1",
      content: { type: "text", text: "hello" },
    }]);
    expect(second[0]).toMatchObject({ messageId: "message-1", content: { text: " world" } });
    expect(next[0]).toMatchObject({ messageId: "message-2", content: { text: "next" } });
  });

  it("maps the complete Pi tool lifecycle using stable ACP v2 fields", () => {
    const mapper = makePiEventMapper({ createMessageId: () => "unused" });

    const pending = mapper.map(event({
      type: "message_update",
      message: assistantMessage,
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "/tmp/file" } },
        partial: assistantMessage,
      },
    }));
    const started = mapper.map(event({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "/tmp/file" },
    }));
    const progress = mapper.map(event({
      type: "tool_execution_update",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "/tmp/file" },
      partialResult: {
        content: [{ type: "text", text: "read 4 bytes" }],
        details: { internalPath: "/tmp/file", bytes: 4 },
      },
    }));
    const completed = mapper.map(event({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "read",
      result: {
        content: [{ type: "text", text: "done" }],
        details: { internalPath: "/tmp/file" },
      },
      isError: false,
    }));

    expect(pending).toEqual([{
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      title: "read",
      status: "pending",
    }]);
    expect(started).toEqual([{
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      title: "read",
      status: "in_progress",
    }]);
    expect(progress).toEqual([{
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      content: [{ type: "content", content: { type: "text", text: "read 4 bytes" } }],
    }]);
    expect(completed).toEqual([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        content: [{ type: "content", content: { type: "text", text: "done" } }],
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        title: "read",
        status: "completed",
      },
    ]);
    const serialized = JSON.stringify({ pending, started, progress, completed });
    expect(serialized).not.toContain("rawInput");
    expect(serialized).not.toContain("rawOutput");
    expect(serialized).not.toContain('"name"');
    expect(serialized).not.toContain("details");
    expect(serialized).not.toContain("internalPath");
  });

  it("maps failures and drops unsupported or non-displayable events without throwing", () => {
    const mapper = makePiEventMapper({ createMessageId: () => "message" });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    expect(mapper.map(event({
      type: "tool_execution_end",
      toolCallId: "tool-failed",
      toolName: "write",
      result: {
        content: [{ type: "image", data: "private-image", mimeType: "image/png" }],
        details: cyclic,
      },
      isError: true,
    }))).toEqual([{
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-failed",
      title: "write",
      status: "failed",
    }]);
    expect(mapper.map(event({
      type: "tool_execution_update",
      toolCallId: "tool-failed",
      toolName: "write",
      args: {},
      partialResult: undefined,
    }))).toEqual([]);
    expect(mapper.map(event({ type: "agent_start" }))).toEqual([]);
    expect(mapper.map(event({ type: "turn_start" }))).toEqual([]);
  });
});
