import { Effect } from 'effect'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IntegrationError, joinedTryPromise, type IngestInput } from '../base/index.ts'
import { maintainCredentials } from './oauth.ts'

type GmailList = { messages?: Array<{ id?: string }>; nextPageToken?: string }
type GmailMessage = {
  id?: string
  threadId?: string
  internalDate?: string
  labelIds?: string[]
  payload?: { headers?: Array<{ name?: string; value?: string }>; parts?: unknown[]; body?: { data?: string }; mimeType?: string }
}

const safeId = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_')

/** Materializes provider-native Gmail message projections for one exact half-open window. */
export const ingestGmail = Effect.fn('Gmail.ingest')(function* (input: IngestInput) {
  if (input.window.end <= input.window.start) return yield* new IntegrationError({ message: 'The Gmail ingestion window is invalid.' })
  const credentials = yield* maintainCredentials(input.integrationDirectory)
  yield* joinedTryPromise({
    try: async (signal) => {
      const api = async <A>(path: string): Promise<A> => {
        const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
          signal,
          headers: { authorization: `Bearer ${credentials.accessToken}` }
        })
        if (!response.ok) throw new Error(`Gmail API request failed (${response.status})`)
        return await response.json() as A
      }
      const query = `after:${Math.floor(input.window.start / 1000) - 1} before:${Math.ceil(input.window.end / 1000) + 1}`
      const ids = new Set<string>()
      const cursors = new Set<string>()
      let pageToken: string | undefined
      do {
        const params = new URLSearchParams({ q: query, maxResults: '100' })
        if (pageToken) params.set('pageToken', pageToken)
        const page = await api<GmailList>(`messages?${params}`)
        for (const message of page.messages ?? []) if (message.id) ids.add(message.id)
        pageToken = page.nextPageToken
        if (pageToken && cursors.has(pageToken)) throw new Error('Gmail pagination repeated a cursor')
        if (pageToken) cursors.add(pageToken)
      } while (pageToken)

      await mkdir(input.outputDirectory, { recursive: true, mode: 0o700 })
      for (const id of ids) {
        const message = await api<GmailMessage>(`messages/${encodeURIComponent(id)}?format=full`)
        const receivedAt = Number(message.internalDate)
        if (!Number.isFinite(receivedAt)) throw new Error('Gmail returned an invalid message timestamp')
        if (receivedAt < input.window.start || receivedAt >= input.window.end) continue
        const headers = Object.fromEntries((message.payload?.headers ?? [])
          .filter((header): header is { name: string; value: string } => typeof header.name === 'string' && typeof header.value === 'string')
          .map(header => [header.name.toLowerCase(), header.value]))
        const body: string[] = []
        const visit = (part: unknown): void => {
          if (!part || typeof part !== 'object') return
          const value = part as { mimeType?: string; body?: { data?: string }; parts?: unknown[] }
          if (value.mimeType === 'text/plain' && value.body?.data) body.push(Buffer.from(value.body.data, 'base64url').toString('utf8'))
          for (const child of value.parts ?? []) visit(child)
        }
        visit(message.payload)
        const content = [
          '---',
          `source: "gmail/email"`,
          `message_id: ${JSON.stringify(id)}`,
          `thread_id: ${JSON.stringify(message.threadId ?? null)}`,
          `received_at: ${JSON.stringify(new Date(receivedAt).toISOString())}`,
          `time_zone: ${JSON.stringify(input.window.timeZone)}`,
          '---',
          '',
          `# ${headers.subject ?? '(no subject)'}`,
          '',
          `- From: ${headers.from ?? ''}`,
          `- To: ${headers.to ?? ''}`,
          `- Gmail labels: ${(message.labelIds ?? []).join(', ') || '(none)'}`,
          '',
          body.join('\n\n').trim() || '(empty body)',
          ''
        ].join('\n')
        await writeFile(join(input.outputDirectory, `${safeId(id)}.md`), content, { mode: 0o600, signal })
      }
    },
    catch: () => new IntegrationError({ message: 'Gmail ingestion failed. Check the connection and retry the same window.' })
  })
}, Effect.mapError(error => error instanceof IntegrationError ? error
  : new IntegrationError({ message: 'Gmail ingestion failed. Check the connection and retry the same window.' })))
