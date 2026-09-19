import { createHash } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const argument = name => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const start = argument('--start'), end = argument('--end'), output = argument('--output')
const startTime = Date.parse(start), endTime = Date.parse(end)
if (!output || !Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) {
  throw new Error('Usage: extract-window.mjs --start <ISO> --end <ISO> --output <directory>; requires a valid ordered time window')
}

const oneLine = value => String(value ?? '').replace(/[\r\n]+/g, ' ')
const linkText = value => oneLine(value).replace(/[\\[\]]/g, '\\$&')
const hash = value => createHash('sha256').update(value).digest('hex')
let stage = 'initialize'
const startedAt = Date.now()
// Fixed stages and counts are safe to log; server responses and MIME content are not.
const progress = (data = {}) => console.log('[Folio][IMAP]', JSON.stringify({ stage, elapsedMs: Date.now() - startedAt, ...data }))

/** Search by IMAP's day-granularity INTERNALDATE, then enforce the exact [start,end) window. */
async function extract() {
  progress({ windowStart: new Date(startTime).toISOString(), windowEnd: new Date(endTime).toISOString(), windowMs: endTime - startTime })
  // Invalidate a previous success marker before attempting a retry.
  await mkdir(output, { recursive: true, mode: 0o700 })
  await rm(join(output, '_updated.md'), { force: true })
  const require = createRequire(import.meta.url)
  const { ImapFlow } = require(process.env.IMAPFLOW_MODULE_PATH)
  const { simpleParser } = require(process.env.IMAP_MAILPARSER_MODULE_PATH)
  const { convert } = require(process.env.IMAP_HTML_TO_TEXT_MODULE_PATH)
  const config = JSON.parse(process.env.IMAP_CONNECTION)
  const client = new ImapFlow({
    host: config.host, port: config.port, secure: config.security === 'tls',
    doSTARTTLS: config.security === 'starttls' ? true : undefined,
    auth: { user: config.user, pass: config.password }, proxy: config.proxy,
    logger: false, disableAutoIdle: true,
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000
  })
  client.on('error', () => {})
  const messages = []
  try {
    stage = 'connect'
    progress()
    await client.connect()
    stage = 'open-folder'
    progress()
    const mailbox = await client.mailboxOpen(config.mailbox, { readOnly: true })
    if (!mailbox.uidValidity) throw new Error('Mailbox UID validity is missing')
    const identity = hash(JSON.stringify([config.host, config.port, config.user, config.mailbox, String(mailbox.uidValidity)]))
    // INTERNALDATE search ignores time/zone. Cover adjacent days to avoid losing
    // messages whose server-local calendar date differs from UTC.
    const day = timestamp => new Date(timestamp).toISOString().slice(0, 10)
    stage = 'search'
    const found = startTime === endTime ? [] : await client.search({
      since: day(startTime - 86_400_000), before: day(endTime + 86_400_000)
    }, { uid: true })
    if (!Array.isArray(found)) throw new Error('IMAP search failed')
    const uids = [...new Set(found)]
    progress({ candidateCount: uids.length })
    await mkdir(join(output, 'messages'), { recursive: true, mode: 0o700 })
    for (let offset = 0; offset < uids.length; offset += 100) {
      stage = 'fetch-metadata'
      const batch = uids.slice(offset, offset + 100)
      // Fetch metadata before bodies so old or large unrelated messages are not downloaded.
      const metadata = await client.fetchAll(batch, { uid: true, internalDate: true, size: true }, { uid: true })
      const returned = new Set(metadata.map(message => message.uid))
      if (batch.some(uid => !returned.has(uid))) throw new Error('Mailbox changed during extraction; retry the window')
      for (const item of metadata) {
        const receivedAt = new Date(item.internalDate).getTime()
        if (!Number.isFinite(receivedAt)) throw new Error('Message timestamp is missing')
        if (receivedAt < startTime || receivedAt >= endTime) continue
        // Parsing buffers MIME content; fail explicitly instead of silently omitting oversized mail.
        if (!Number.isFinite(item.size) || item.size > 25 * 1024 * 1024) throw new Error('Message exceeds the 25 MiB extraction limit')
        stage = 'fetch-body'
        const fetched = await client.fetchOne(item.uid, { uid: true, source: true }, { uid: true })
        if (!fetched || fetched.uid !== item.uid || !fetched.source) throw new Error('Message disappeared during extraction')
        stage = 'parse-body'
        const parsed = await simpleParser(fetched.source, { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true })
        // MailParser can omit text for HTML-only multipart messages. Preserve an
        // authored plain-text body first, then explicitly convert the decoded HTML.
        const body = parsed.text?.trim() || (typeof parsed.html === 'string'
          ? convert(parsed.html, { wordwrap: false }).trim() : '')
        progress({ uid: item.uid, bodySource: parsed.text?.trim() ? 'text' : body ? 'html' : 'empty', bodyLength: body.length })
        const id = `${identity}-${item.uid}`
        const subject = oneLine(parsed.subject || '(no subject)')
        const from = oneLine(parsed.from?.text)
        const to = oneLine(Array.isArray(parsed.to) ? parsed.to.map(value => value.text).join(', ') : parsed.to?.text)
        const content = [
          `# ${subject}`, '', `- From: ${from}`, `- To: ${to}`,
          `- Received: ${new Date(receivedAt).toISOString()}`, `- Folder: ${oneLine(config.mailbox)}`,
          `- Message-ID: ${oneLine(parsed.messageId)}`, '', body || '(empty body)', ''
        ].join('\n')
        await writeFile(join(output, 'messages', `${id}.md`), content, { mode: 0o600 })
        messages.push({ id, subject, from, receivedAt })
      }
    }
    stage = 'logout'
    await client.logout()
  } finally {
    client.close()
  }
  messages.sort((a, b) => a.receivedAt - b.receivedAt || a.id.localeCompare(b.id))
  stage = 'publish-summary'
  const summary = [
    '# IMAP messages updated', '', `Window: ${new Date(startTime).toISOString()} → ${new Date(endTime).toISOString()}`,
    `Folder: ${oneLine(config.mailbox)}`, `Messages: ${messages.length}`, '',
    ...messages.map(message => `- [${linkText(message.subject)}](messages/${message.id}.md) — ${message.from}`), ''
  ].join('\n')
  await writeFile(join(output, '_updated.md.tmp'), summary, { mode: 0o600 })
  await rename(join(output, '_updated.md.tmp'), join(output, '_updated.md'))
  stage = 'completed'
  progress({ messageCount: messages.length })
}

// SDK/MIME exceptions can contain raw server responses and credentials. Keep task logs safe.
try {
  await extract()
} catch {
  console.error('[Folio][IMAP]', JSON.stringify({ stage, status: 'failed', elapsedMs: Date.now() - startedAt }))
  console.error('IMAP extraction failed. Check the connection and folder, then retry. The window is incomplete; messages over 25 MiB are not supported.')
  process.exitCode = 1
}
