import { Schema } from 'effect'
import { parse } from 'yaml'

const ChatMetadata = Schema.Struct({
  source: Schema.Literal('lark/im'),
  chat_name: Schema.String,
  time_zone: Schema.String
})
const decodeMetadata = Schema.decodeUnknownSync(ChatMetadata)

export interface EvidenceMessage {
  id: string
  timestamp: string
  sender: string
  text: string
}

/** Reads the Lark ingestion format only. Unknown formats retain the complete original text. */
export function readEvidenceConversation(content: string): {
  title: string; timeZone: string; messages: EvidenceMessage[]
} | null {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
  if (!frontmatter) return null
  try {
    const metadata = decodeMetadata(parse(frontmatter[1]!))
    const messages: EvidenceMessage[] = []
    for (const line of content.slice(frontmatter[0].length).split(/\r?\n/)) {
      if (!line.trim() || (!messages.length && line.startsWith('# '))) continue
      // Sender names and message bodies may contain pipes. The message ID anchors the delimiter.
      const match = /^- (\d{4}-\d{2}-\d{2}[ T][^|]+?) \| (.*?) \| (om_[^\s|]+|unknown message id) \| (.*)$/.exec(line)
      if (!match) return null
      messages.push({ timestamp: match[1]!, sender: match[2]!, id: match[3]!, text: match[4]!.replace(/ ↵ /g, '\n') })
    }
    return messages.length ? { title: metadata.chat_name, timeZone: metadata.time_zone, messages } : null
  } catch {
    return null
  }
}

/** A citation must identify exactly one record; a substring in another message is not an anchor. */
export function citedMessageIndex(messages: readonly EvidenceMessage[], fragment: string | null): number {
  if (!fragment) return -1
  let id: string
  try { id = decodeURIComponent(fragment) } catch { return -1 }
  const indices = messages.flatMap((message, index) => message.id === id ? [index] : [])
  return indices.length === 1 ? indices[0]! : -1
}
