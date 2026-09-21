import { Effect } from 'effect'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { convert } from 'html-to-text'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { IntegrationError, joinedTryPromise, type IngestInput } from '../base/index.ts'
import { readPrivateState } from './state.ts'

const oneLine = (value: unknown) => String(value ?? '').replace(/[\r\n]+/g, ' ')

/** Reads an IMAP folder without changing flags and writes stable UID-based message projections. */
export const ingestImap = Effect.fn('Imap.ingest')(function* (input: IngestInput) {
  const { credentials } = yield* readPrivateState(input.integrationDirectory)
  if (!credentials || input.window.end <= input.window.start) return yield* new IntegrationError({ message: 'The IMAP ingestion window or connection is unavailable.' })
  const client = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const value = new ImapFlow({
        host: credentials.host, port: credentials.port, secure: credentials.security === 'tls',
        doSTARTTLS: credentials.security === 'starttls' ? true : undefined,
        auth: { user: credentials.user, pass: credentials.password }, proxy: credentials.proxy,
        logger: false, disableAutoIdle: true,
        connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000
      })
      value.on('error', () => undefined)
      return value
    }),
    value => Effect.sync(() => value.close())
  )
  yield* joinedTryPromise({
    try: async (signal) => {
      const close = () => client.close()
      signal.addEventListener('abort', close, { once: true })
      try {
        await client.connect()
        const mailbox = await client.mailboxOpen(credentials.mailbox, { readOnly: true })
        if (!mailbox.uidValidity) throw new Error('Mailbox UID validity is missing')
        const identity = createHash('sha256').update(JSON.stringify([
          credentials.host, credentials.port, credentials.user, credentials.mailbox, String(mailbox.uidValidity)
        ])).digest('hex')
        const day = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 10)
        const found = await client.search({
          since: day(input.window.start - 86_400_000),
          before: day(input.window.end + 86_400_000)
        }, { uid: true })
        if (!Array.isArray(found)) throw new Error('IMAP search failed')
        await mkdir(input.outputDirectory, { recursive: true, mode: 0o700 })
        const uids = [...new Set(found)]
        for (let offset = 0; offset < uids.length; offset += 100) {
          signal.throwIfAborted()
          const batch = uids.slice(offset, offset + 100)
          const metadata = await client.fetchAll(batch, { uid: true, internalDate: true, size: true }, { uid: true })
          const returned = new Set(metadata.map(message => message.uid))
          if (batch.some(uid => !returned.has(uid))) throw new Error('Mailbox changed during extraction')
          for (const item of metadata) {
            signal.throwIfAborted()
            if (!item.internalDate) throw new Error('Message timestamp is missing')
            const receivedAt = new Date(item.internalDate).getTime()
            if (!Number.isFinite(receivedAt)) throw new Error('Message timestamp is missing')
            if (receivedAt < input.window.start || receivedAt >= input.window.end) continue
            if (typeof item.size !== 'number' || !Number.isFinite(item.size) || item.size > 25 * 1024 * 1024) throw new Error('Message exceeds the extraction limit')
            const fetched = await client.fetchOne(item.uid, { uid: true, source: true }, { uid: true })
            if (!fetched || fetched.uid !== item.uid || !fetched.source) throw new Error('Message disappeared during extraction')
            const parsed = await simpleParser(fetched.source, { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true })
            const body = parsed.text?.trim() || (typeof parsed.html === 'string' ? convert(parsed.html, { wordwrap: false }).trim() : '')
            const id = `${identity}-${item.uid}`
            const subject = oneLine(parsed.subject || '(no subject)')
            const from = oneLine(parsed.from?.text)
            const to = oneLine(Array.isArray(parsed.to) ? parsed.to.map(value => value.text).join(', ') : parsed.to?.text)
            const content = [
              '---',
              `source: "imap/email"`,
              `message_id: ${JSON.stringify(id)}`,
              `uid: ${item.uid}`,
              `received_at: ${JSON.stringify(new Date(receivedAt).toISOString())}`,
              `time_zone: ${JSON.stringify(input.window.timeZone)}`,
              '---', '', `# ${subject}`, '', `- From: ${from}`, `- To: ${to}`,
              `- Folder: ${oneLine(credentials.mailbox)}`, `- Message-ID: ${oneLine(parsed.messageId)}`,
              '', body || '(empty body)', ''
            ].join('\n')
            await writeFile(join(input.outputDirectory, `${id}.md`), content, { mode: 0o600, signal })
          }
        }
        await client.logout()
      } finally {
        signal.removeEventListener('abort', close)
      }
    },
    catch: () => new IntegrationError({ message: 'IMAP ingestion failed. Check the connection and retry the same window.' })
  })
}, Effect.scoped, Effect.mapError(error => error instanceof IntegrationError ? error
  : new IntegrationError({ message: 'IMAP ingestion failed. Check the connection and retry the same window.' })))
