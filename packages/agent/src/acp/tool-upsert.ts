import type { ToolCallUpdate } from "@agentclientprotocol/sdk/experimental/v2";

export type ToolCallSnapshot = {
  readonly toolCallId: string;
  readonly name?: string;
  readonly title?: string;
  readonly status?: string;
  readonly content?: ToolCallUpdate["content"];
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
};

const patch = <T>(current: T | undefined, next: T | null | undefined): T | undefined =>
  next === undefined ? current : (next ?? undefined);

/** Applies ACP v2 omitted / null / value patch semantics for tool call upserts. */
export const applyToolCallUpdate = (
  current: ToolCallSnapshot | undefined,
  update: ToolCallUpdate,
): ToolCallSnapshot => ({
  toolCallId: update.toolCallId,
  name: patch(current?.name, update.name),
  title: patch(current?.title, update.title),
  status: patch(current?.status, update.status),
  content: patch(current?.content, update.content),
  rawInput: update.rawInput === undefined ? current?.rawInput : update.rawInput,
  rawOutput: update.rawOutput === undefined ? current?.rawOutput : update.rawOutput,
});
