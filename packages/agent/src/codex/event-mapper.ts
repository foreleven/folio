import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { Effect, Schema } from "effect";
import type { CodexServerEvent } from "./connection.js";

const Ids = { threadId: Schema.String, turnId: Schema.String };
const Delta = Schema.Struct({ ...Ids, itemId: Schema.String, delta: Schema.String });
const ItemEnvelope = Schema.Struct({ ...Ids, item: Schema.Struct({ id: Schema.String, type: Schema.String }) });
const ItemData = Schema.Struct({ ...Ids, item: Schema.Unknown });
const TextItem = Schema.Struct({ id: Schema.String, type: Schema.Literal("agentMessage"), text: Schema.String });
const Status = Schema.Literals(["inProgress", "completed", "failed", "declined"]);
const Command = Schema.Struct({
  id: Schema.String, type: Schema.Literal("commandExecution"), command: Schema.String, cwd: Schema.String,
  status: Status, aggregatedOutput: Schema.optional(Schema.NullOr(Schema.String)),
});
const FileChange = Schema.Struct({
  id: Schema.String, type: Schema.Literal("fileChange"), status: Status,
  changes: Schema.Array(Schema.Struct({ path: Schema.String, diff: Schema.String })),
});
const Reasoning = Schema.Struct({
  id: Schema.String, type: Schema.Literal("reasoning"),
  summary: Schema.optional(Schema.Array(Schema.String)), content: Schema.optional(Schema.Array(Schema.String)),
});

/** Stable decode failure, without embedding native event payloads in public errors. */
export class CodexEventError extends Schema.TaggedError<CodexEventError>()("CodexEventError", {
  message: Schema.String,
}) {}

/** Namespaces native item IDs by Turn; their uniqueness must not be assumed across turns. */
export const codexItemId = (turnId: string, itemId: string): string => JSON.stringify(["codex", turnId, itemId]);

const content = (text: string) => ({ type: "content" as const, content: { type: "text" as const, text } });
const status = (native: typeof Status.Type) => native === "inProgress" ? "in_progress" as const
  : native === "completed" ? "completed" as const : "failed" as const;

/**
 * Maps known native display events to ACP. Final native items replace earlier chunks, including
 * corrected final assistant text and aggregated command output. Turn state is owned by the runtime.
 * Unknown native events currently have no display projection; callers can retain their raw event.
 */
export const mapCodexEvent = (event: CodexServerEvent): Effect.Effect<SessionUpdate[], CodexEventError> => Effect.try({
  try: () => {
    if (event.method === "item/agentMessage/delta" || event.method === "item/commandExecution/outputDelta") {
      const value = Schema.decodeUnknownSync(Delta)(event.params);
      const id = codexItemId(value.turnId, value.itemId);
      return event.method === "item/agentMessage/delta"
        ? [{ sessionUpdate: "agent_message_chunk", messageId: id, content: { type: "text", text: value.delta } }]
        : [{ sessionUpdate: "tool_call_content_chunk", toolCallId: id, content: content(value.delta) }];
    }
    if (event.method !== "item/started" && event.method !== "item/completed") return [];
    const envelope = Schema.decodeUnknownSync(ItemEnvelope)(event.params);
    const raw = Schema.decodeUnknownSync(ItemData)(event.params).item;
    const id = codexItemId(envelope.turnId, envelope.item.id);
    switch (envelope.item.type) {
      case "agentMessage": {
        const item = Schema.decodeUnknownSync(TextItem)(raw);
        return event.method === "item/completed"
          ? [{ sessionUpdate: "agent_message", messageId: id, _meta: { "folio/messageComplete": true }, content: [{ type: "text", text: item.text }] }] : [];
      }
      case "commandExecution": {
        const item = Schema.decodeUnknownSync(Command)(raw);
        return [{ sessionUpdate: "tool_call_update", toolCallId: id, title: item.command,
          kind: "execute", status: status(item.status), rawInput: { command: item.command, cwd: item.cwd },
          ...(item.aggregatedOutput == null ? {} : { content: [content(item.aggregatedOutput)] }),
        }];
      }
      case "fileChange": {
        const item = Schema.decodeUnknownSync(FileChange)(raw);
        return [{ sessionUpdate: "tool_call_update", toolCallId: id, title: "Edit files", kind: "edit",
          status: status(item.status), locations: item.changes.map(({ path }) => ({ path })),
          content: item.changes.map(({ path, diff }) => content(`${path}\n${diff}`)),
        }];
      }
      case "reasoning": {
        const item = Schema.decodeUnknownSync(Reasoning)(raw);
        return event.method === "item/completed" ? [{ sessionUpdate: "agent_thought", messageId: id, _meta: { "folio/messageComplete": true },
          content: [{ type: "text", text: (item.summary ?? item.content ?? []).join("\n") }] }] : [];
      }
      default: return [];
    }
  },
  catch: () => new CodexEventError({ message: "Codex emitted an invalid display event." }),
});
