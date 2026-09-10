import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface PiEventMapperOptions {
  readonly createMessageId: () => string;
}

export interface PiEventMapper {
  readonly map: (event: AgentSessionEvent) => ReadonlyArray<SessionUpdate>;
}

const textContent = (text: string) => ({
  type: "content" as const,
  content: {
    type: "text" as const,
    text,
  },
});

const displayText = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null || !("content" in value)) {
    return undefined;
  }
  const content = value.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .filter((item): item is { readonly type: "text"; readonly text: string } =>
      typeof item === "object"
      && item !== null
      && "type" in item
      && item.type === "text"
      && "text" in item
      && typeof item.text === "string")
    .map((item) => item.text)
    .filter((part) => part.length > 0)
    .join("\n");
  return text.length > 0 ? text : undefined;
};

export const makePiEventMapper = ({ createMessageId }: PiEventMapperOptions): PiEventMapper => {
  let assistantMessageId: string | undefined;

  return {
    map: (event) => {
      switch (event.type) {
        case "message_start":
          if (event.message.role === "assistant") {
            assistantMessageId = createMessageId();
          }
          return [];

        case "message_update": {
          if (event.assistantMessageEvent.type === "text_delta") {
            assistantMessageId ??= createMessageId();
            return [{
              sessionUpdate: "agent_message_chunk",
              messageId: assistantMessageId,
              content: {
                type: "text",
                text: event.assistantMessageEvent.delta,
              },
            }];
          }

          if (event.assistantMessageEvent.type === "toolcall_end") {
            const { toolCall } = event.assistantMessageEvent;
            return [{
              sessionUpdate: "tool_call_update",
              toolCallId: toolCall.id,
              title: toolCall.name,
              status: "pending",
            }];
          }

          return [];
        }

        case "message_end":
          if (event.message.role === "assistant") {
            assistantMessageId = undefined;
          }
          return [];

        case "tool_execution_start":
          return [{
            sessionUpdate: "tool_call_update",
            toolCallId: event.toolCallId,
            title: event.toolName,
            status: "in_progress",
          }];

        case "tool_execution_update": {
          const text = displayText(event.partialResult);
          return text === undefined ? [] : [{
            sessionUpdate: "tool_call_content_chunk",
            toolCallId: event.toolCallId,
            content: textContent(text),
          }];
        }

        case "tool_execution_end": {
          const text = displayText(event.result);
          const updates: SessionUpdate[] = [];
          if (text !== undefined) {
            updates.push({
              sessionUpdate: "tool_call_content_chunk",
              toolCallId: event.toolCallId,
              content: textContent(text),
            });
          }
          updates.push({
            sessionUpdate: "tool_call_update",
            toolCallId: event.toolCallId,
            title: event.toolName,
            status: event.isError ? "failed" : "completed",
          });
          return updates;
        }

        default:
          return [];
      }
    },
  };
};
