import { SessionUpdate } from '@agentclientprotocol/sdk/experimental/v2'
import { Schema } from 'effect'
import { ProjectedMessage } from '../../shared/harness-events'

export type DisplayChange =
  | { kind: 'message'; id: string; apply: (previous: Schema.JsonObject | undefined) => Schema.JsonObject }
  | { kind: 'tool'; id: string; apply: (previous: Schema.JsonObject | undefined) => Schema.JsonObject }
  | { kind: 'idle' }
  | { kind: 'none' }
const json = Schema.decodeUnknownSync(Schema.JsonObject)

/**
 * Applies v2 patch semantics: omission preserves, null clears, chunks append, concrete arrays replace.
 * An upsert is not a completion signal; only foreground idle ends messages. Unmapped updates stay raw.
 */
export function projectUpdate(input: Schema.JsonObject): DisplayChange {
  const update = Schema.decodeUnknownSync(Schema.Struct({ sessionUpdate: Schema.String }))(input, { onExcessProperty: 'preserve' })
  const message = SessionUpdate.isUserMessage(update) || SessionUpdate.isAgentMessage(update) || SessionUpdate.isAgentThought(update)
  const chunk = SessionUpdate.isUserMessageChunk(update) || SessionUpdate.isAgentMessageChunk(update) || SessionUpdate.isAgentThoughtChunk(update)
  if (message || chunk) {
    const role = update.sessionUpdate.startsWith('user_') ? 'user' : update.sessionUpdate.startsWith('agent_thought') ? 'thought' : 'assistant'
    return { kind: 'message', id: update.messageId, apply: (previous) => {
      const old = previous ? Schema.decodeUnknownSync(ProjectedMessage)(previous) : { role, content: [], metadata: null, ended: false }
      if (old.role !== role) throw new Error('Message role changed')
      return json({ role,
        content: chunk ? [...old.content, update.content] : update.content === undefined ? old.content : update.content ?? [],
        metadata: chunk || update._meta === undefined ? old.metadata : update._meta,
        // A later metadata/content correction does not reopen a message already ended by idle.
        ended: old.ended
      })
    } }
  }
  if (SessionUpdate.isToolCallUpdate(update)) {
    return { kind: 'tool', id: update.toolCallId, apply: (previous) => {
      const { sessionUpdate: _kind, toolCallId: _id, ...patch } = update
      // Tool patches preserve omitted fields and deliberately retain explicit null clear signals.
      return json({ ...previous, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) })
    } }
  }
  if (SessionUpdate.isToolCallContentChunk(update)) {
    return { kind: 'tool', id: update.toolCallId, apply: (previous) => {
      const content = previous?.content == null ? [] : Schema.decodeUnknownSync(Schema.Array(Schema.Json))(previous.content)
      return json({ ...previous, content: [...content, update.content] })
    } }
  }
  if (SessionUpdate.isStateUpdate(update)) return { kind: update.state === 'idle' ? 'idle' : 'none' }
  // Do not silently ignore a malformed variant whose display semantics we claim to support.
  if (['user_message', 'user_message_chunk', 'agent_message', 'agent_message_chunk', 'agent_thought', 'agent_thought_chunk',
    'tool_call_update', 'tool_call_content_chunk', 'state_update'].includes(update.sessionUpdate)) throw new Error('Invalid ACP update')
  return { kind: 'none' }
}
