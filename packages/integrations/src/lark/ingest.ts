import { Effect, Schema } from 'effect'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IntegrationError, joinedTryPromise, type IngestInput } from '../base/index.ts'
import { openCli, type LarkCli } from './cli.ts'
import { readPrivateState } from './state.ts'

const envelope = (value: unknown): unknown => value && typeof value === 'object' && 'data' in value ? (value as { data: unknown }).data : value
const object = (value: unknown, label: string): Record<string, unknown> => {
  const unwrapped = envelope(value)
  if (!unwrapped || typeof unwrapped !== 'object') throw new Error(`Invalid ${label} response`)
  return unwrapped as Record<string, unknown>
}
const rows = (value: Record<string, unknown>, key: string): unknown[] => {
  if (!Array.isArray(value[key])) throw new Error(`Missing ${key}`)
  return value[key]
}
/** Lark IM uses epoch seconds while Mail uses milliseconds; accept either without shifting Routine windows. */
const parseTime = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d+$/.test(value) ? Number(value)
      : typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) && Math.abs(parsed) < 100_000_000_000 ? parsed * 1000 : parsed
}
const oneLine = (value: unknown) => String(value ?? '').replace(/\r\n|[\r\n\u2028\u2029]/g, ' ↵ ')
const safeId = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_')

const credentials = Effect.fn('Lark.ingestCredentials')(function* (directory: string) {
  const state = yield* readPrivateState(directory)
  if (!state.app || !state.userAuth) return yield* new IntegrationError({ message: 'Lark user authorization is unavailable.' })
  return {
    token: state.userAuth.accessToken,
    environment: {
      LARKSUITE_CLI_APP_ID: state.app.clientId,
      LARKSUITE_CLI_APP_SECRET: state.app.clientSecret,
      LARKSUITE_CLI_BRAND: state.app.brand,
      LARKSUITE_CLI_DEFAULT_AS: 'user',
      ...(state.appAuth ? { LARKSUITE_CLI_TENANT_ACCESS_TOKEN: state.appAuth.tenantAccessToken ?? state.appAuth.appAccessToken } : {})
    }
  }
})

interface IngestSession {
  readonly auth: { readonly token: string, readonly environment: Readonly<Record<string, string>> }
  readonly cli: LarkCli
}

/** Resolves credentials and verifies the CLI once for every provider ingestion operation. */
const openIngestSession = Effect.fn('Lark.openIngestSession')(function*(directory: string) {
  const auth = yield* credentials(directory)
  const cli = yield* openCli(directory)
  return { auth, cli }
})

const command = (session: IngestSession, args: readonly string[]) => Effect.gen(function* () {
  const text = yield* session.cli.run(args, session.auth.token, session.auth.environment)
  return yield* Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => new IntegrationError({ message: 'The managed lark-cli returned invalid data.' })
  })
})

const MuteStatusResponse = Schema.Struct({
  items: Schema.Array(Schema.Struct({ chat_id: Schema.NonEmptyString, is_muted: Schema.Boolean }))
})

const MailTriageResponse = Schema.Struct({
  messages: Schema.Array(Schema.Struct({ message_id: Schema.NonEmptyString })),
  mailbox_id: Schema.NonEmptyString,
  has_more: Schema.Boolean,
  page_token: Schema.optional(Schema.String)
})
const MailAddress = Schema.Struct({
  name: Schema.optional(Schema.String),
  mail_address: Schema.optional(Schema.String)
})
const MailMessage = Schema.Struct({
  message_id: Schema.NonEmptyString,
  thread_id: Schema.optional(Schema.Unknown),
  subject: Schema.optional(Schema.Unknown),
  internal_date: Schema.Union([Schema.String, Schema.Number]),
  folder_id: Schema.optional(Schema.Unknown),
  head_from: Schema.optional(MailAddress),
  to: Schema.optional(Schema.Array(MailAddress)),
  body_plain_text: Schema.optional(Schema.Unknown),
  body_preview: Schema.optional(Schema.Unknown)
})
const MailMessagesResponse = Schema.Struct({
  messages: Schema.Array(MailMessage),
  total: Schema.Int,
  unavailable_message_ids: Schema.Array(Schema.NonEmptyString)
})

/** Message search ignores per-user notification settings, so muted chats must be filtered explicitly. */
const readMutedChatIds = Effect.fn('Lark.readMutedChatIds')(function* (session: IngestSession, chatIds: readonly string[]) {
  const batches: string[][] = []
  for (let index = 0; index < chatIds.length; index += 10) batches.push(chatIds.slice(index, index + 10))
  const responses = yield* Effect.forEach(batches, batch => command(session, [
    'im', 'chat.user_setting', 'batch_query', '--as', 'user',
    '--data', JSON.stringify({ chat_ids: batch }), '--format', 'json'
  ]).pipe(
    Effect.flatMap(value => Schema.decodeUnknownEffect(MuteStatusResponse)(envelope(value))),
    Effect.mapError(() => new IntegrationError({ message: 'Lark returned an invalid mute status.' }))
  ), { concurrency: 4 })
  const muted = new Set<string>()
  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index]!
    const response = responses[index]!
    const statusByChat = new Map(response.items.map(item => [item.chat_id, item.is_muted]))
    if (statusByChat.size !== response.items.length || response.items.some(item => !batch.includes(item.chat_id))) {
      return yield* new IntegrationError({ message: 'Lark returned an invalid mute status.' })
    }
    for (const chatId of batch) {
      const status = statusByChat.get(chatId)
      if (status === undefined) return yield* new IntegrationError({ message: 'Lark returned incomplete mute status.' })
      if (status) muted.add(chatId)
    }
  }
  return muted
})

const formatZoned = (epoch: number, timeZone: string): string => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, calendar: 'iso8601', numberingSystem: 'latn', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  })
  const parts = Object.fromEntries(formatter.formatToParts(new Date(epoch)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}

/** Writes one file per chat with frontmatter and compact one-line messages. */
export const ingestLarkIm = Effect.fn('Lark.ingestIm')(function* (input: IngestInput) {
  const session = yield* openIngestSession(input.integrationDirectory)
  const start = new Date(Math.floor(input.window.start / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const end = new Date(Math.ceil(input.window.end / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const messages: Array<Record<string, unknown>> = []
  let pageToken: string | undefined
  let pages = 0
  do {
    const args = ['im', '+messages-search', '--as', 'user', '--query', '', '--start', start, '--end', end,
      '--page-size', '50', '--format', 'json', '--no-reactions']
    if (pageToken) args.push('--page-token', pageToken)
    const page = object(yield* command(session, args), 'messages')
    for (const row of rows(page, 'messages')) {
      if (!row || typeof row !== 'object') throw new IntegrationError({ message: 'Lark returned an invalid message.' })
      const message = row as Record<string, unknown>
      const at = parseTime(message.create_time)
      if (!Number.isFinite(at)) return yield* new IntegrationError({ message: 'Lark returned a message without a valid timestamp.' })
      if (at >= input.window.start && at < input.window.end) messages.push(message)
    }
    pageToken = typeof page.page_token === 'string' && page.page_token ? page.page_token : undefined
    if (page.has_more === true && !pageToken) return yield* new IntegrationError({ message: 'Lark message pagination was incomplete.' })
    if (++pages > 1000) return yield* new IntegrationError({ message: 'Lark message pagination exceeded its safe limit.' })
  } while (pageToken)

  const grouped = new Map<string, Array<Record<string, unknown>>>()
  for (const message of messages) {
    if (typeof message.chat_id !== 'string' || !message.chat_id) continue
    const group = grouped.get(message.chat_id) ?? []
    group.push(message)
    grouped.set(message.chat_id, group)
  }
  const mutedChatIds = yield* readMutedChatIds(session, [...grouped.keys()])
  yield* joinedTryPromise({
    try: async (signal) => {
      await mkdir(input.outputDirectory, { recursive: true, mode: 0o700 })
      for (const [chatId, group] of grouped) {
        const path = join(input.outputDirectory, `${safeId(chatId)}.md`)
        if (mutedChatIds.has(chatId)) {
          await rm(path, { force: true })
          continue
        }
        group.sort((left, right) => parseTime(left.create_time) - parseTime(right.create_time))
        const chatName = typeof group[0]?.chat_name === 'string' ? group[0].chat_name : chatId
        const nextLines = group.map(message => {
          const sender = message.sender && typeof message.sender === 'object' ? message.sender as Record<string, unknown> : {}
          const rawContent = message.content
          const content = message.deleted ? '[recalled]'
            : typeof rawContent === 'string' ? rawContent
              : rawContent && typeof rawContent === 'object' && typeof (rawContent as Record<string, unknown>).text === 'string'
                ? String((rawContent as Record<string, unknown>).text) : `[${message.msg_type ?? 'message'}]`
          return `- ${formatZoned(parseTime(message.create_time), input.window.timeZone)} | ${oneLine(sender.name || 'Unknown')} (${oneLine(sender.id || 'unknown id')}) | ${oneLine(message.message_id || 'unknown message id')} | ${oneLine(content)}`
        })
        const previous = await readFile(path, 'utf8').catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
          throw error
        })
        const merged = new Map<string, string>()
        for (const line of [...previous.split('\n').filter(line => line.startsWith('- ')), ...nextLines]) {
          const match = line.match(/^- [^|]+\|[^|]+\|\s*([^|]+)\s*\|/)
          if (match) merged.set(match[1]!.trim(), line)
        }
        const lines = [...merged.values()].sort()
        const content = [
          '---', `source: "lark/im"`, `chat_id: ${JSON.stringify(chatId)}`, `chat_name: ${JSON.stringify(chatName)}`,
          `chat_type: ${JSON.stringify(group[0]?.chat_type ?? null)}`, `time_zone: ${JSON.stringify(input.window.timeZone)}`,
          '---', '', `# ${chatName}`, '', ...lines, ''
        ].join('\n')
        await writeFile(path, content, { mode: 0o600, signal })
      }
    },
    catch: () => new IntegrationError({ message: 'Lark IM ingestion could not write its raw projection.' })
  })
}, Effect.mapError(error => error instanceof IntegrationError ? error
  : new IntegrationError({ message: 'Lark IM ingestion failed. Check authorization and retry the same window.' })))

/** Uses Lark Mail triage for the exact window, then writes stable message projections. */
export const ingestLarkEmail = Effect.fn('Lark.ingestEmail')(function* (input: IngestInput) {
  const session = yield* openIngestSession(input.integrationDirectory)
  // Lark Mail rejects RFC 3339 fractional seconds, so expand to exact whole-second bounds and filter details below.
  const start = new Date(Math.floor(input.window.start / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const end = new Date(Math.ceil(input.window.end / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const filter = JSON.stringify({ time_range: { start_time: start, end_time: end } })
  const ids = new Set<string>()
  let mailboxId: string | undefined
  let pageToken: string | undefined
  let pages = 0
  do {
    const args = ['mail', '+triage', '--as', 'user', '--filter', filter, '--max', '400', '--format', 'json']
    if (pageToken) args.push('--page-token', pageToken)
    const page = yield* Schema.decodeUnknownEffect(MailTriageResponse)(envelope(yield* command(session, args))).pipe(
      Effect.mapError(() => new IntegrationError({ message: 'Lark returned invalid mail summaries.' }))
    )
    if (mailboxId !== undefined && page.mailbox_id !== mailboxId) {
      return yield* new IntegrationError({ message: 'Lark returned inconsistent mailboxes.' })
    }
    mailboxId = page.mailbox_id
    for (const value of page.messages) ids.add(value.message_id)
    const nextPageToken = typeof page.page_token === 'string' && page.page_token ? page.page_token : undefined
    if (page.has_more === true && !nextPageToken) return yield* new IntegrationError({ message: 'Lark mail pagination was incomplete.' })
    pageToken = page.has_more === true ? nextPageToken : undefined
    if (++pages > 1000) return yield* new IntegrationError({ message: 'Lark mail pagination exceeded its safe limit.' })
  } while (pageToken)
  if (!ids.size) return
  const selectedMailbox = mailboxId ?? 'me'
  const result = yield* Schema.decodeUnknownEffect(MailMessagesResponse)(envelope(yield* command(session, [
    'mail', '+messages', '--as', 'user', '--mailbox', selectedMailbox,
    '--message-ids', [...ids].join(','), '--html=false', '--format', 'json'
  ]))).pipe(Effect.mapError(() => new IntegrationError({ message: 'Lark returned invalid mail bodies.' })))
  const returnedIds = new Set<string>()
  for (const message of result.messages) {
    if (returnedIds.has(message.message_id) || !ids.has(message.message_id)) {
      return yield* new IntegrationError({ message: 'Lark returned invalid mail bodies.' })
    }
    returnedIds.add(message.message_id)
  }
  const unavailableIds = new Set(result.unavailable_message_ids)
  if (result.total !== result.messages.length || unavailableIds.size !== result.unavailable_message_ids.length ||
    result.unavailable_message_ids.some(messageId => !ids.has(messageId) || returnedIds.has(messageId))) {
    return yield* new IntegrationError({ message: 'Lark returned invalid mail bodies.' })
  }
  if ([...ids].some(messageId => !returnedIds.has(messageId) && !unavailableIds.has(messageId))) {
    return yield* new IntegrationError({ message: 'Lark returned incomplete mail bodies.' })
  }
  yield* joinedTryPromise({
    try: async (signal) => {
      await mkdir(input.outputDirectory, { recursive: true, mode: 0o700 })
      for (const message of result.messages) {
        const receivedAt = parseTime(message.internal_date)
        if (!Number.isFinite(receivedAt) || receivedAt < input.window.start || receivedAt >= input.window.end) continue
        const sender = message.head_from ?? {}
        const recipients = message.to?.map(value => `${value.name ?? ''} <${value.mail_address ?? ''}>`).join(', ') ?? ''
        const content = [
          '---', `source: "lark/email"`, `message_id: ${JSON.stringify(message.message_id)}`,
          `thread_id: ${JSON.stringify(message.thread_id ?? null)}`, `received_at: ${JSON.stringify(new Date(receivedAt).toISOString())}`,
          `time_zone: ${JSON.stringify(input.window.timeZone)}`, '---', '', `# ${oneLine(message.subject || '(no subject)')}`, '',
          `- From: ${oneLine(sender.name)} <${oneLine(sender.mail_address)}>`, `- To: ${oneLine(recipients)}`,
          `- Folder: ${oneLine(message.folder_id)}`, '', oneLine(message.body_plain_text || message.body_preview || '(empty body)'), ''
        ].join('\n')
        await writeFile(join(input.outputDirectory, `${safeId(message.message_id)}.md`), content, { mode: 0o600, signal })
      }
    },
    catch: () => new IntegrationError({ message: 'Lark Mail ingestion could not write its raw projection.' })
  })
}, Effect.mapError(error => error instanceof IntegrationError ? error
  : new IntegrationError({ message: 'Lark Mail ingestion failed. Check authorization and retry the same window.' })))
