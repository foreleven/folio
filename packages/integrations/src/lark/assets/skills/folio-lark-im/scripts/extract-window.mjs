#!/usr/bin/env node
/** Extract one complete Lark IM window into workspace raws for a Routine run. */
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1])
const start = args.get('start'); const end = args.get('end'); const timeZone = args.get('time-zone')
if (!start || !end || !timeZone) throw new Error('Usage: extract-window.mjs --start <ISO> --end <ISO> --time-zone <IANA zone> [--output raws/lark-im]')
const startTime = Date.parse(start); const endTime = Date.parse(end)
if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) throw new Error('The extraction window must contain valid ISO timestamps with end after start.')
let zonedFormatter
try {
  zonedFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, calendar: 'iso8601', numberingSystem: 'latn', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    fractionalSecondDigits: 3
  })
} catch {
  throw new Error(`Invalid IANA time zone: ${timeZone}`)
}
/** Renders an instant with the offset active in the Routine zone, including DST transitions. */
const formatZonedTime = epoch => {
  const parts = Object.fromEntries(zonedFormatter.formatToParts(new Date(epoch))
    .filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
  const localEpoch = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second), Number(parts.fractionalSecond))
  const offsetMinutes = Math.round((localEpoch - epoch) / 60_000)
  const offset = offsetMinutes === 0 ? 'Z' : `${offsetMinutes < 0 ? '-' : '+'}${String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, '0')}:${String(Math.abs(offsetMinutes) % 60).padStart(2, '0')}`
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}${offset}`
}
const parseMessageTime = value => {
  if (typeof value === 'number') return value
  if (typeof value === 'string') return /^\d+$/.test(value) ? Number(value) : Date.parse(value)
  return Number.NaN
}
const formatLarkTime = value => new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z')
// Lark rejects fractional seconds. Query a whole-second superset, then apply
// the original exact half-open window locally so sub-second windows stay exact.
const searchStart = formatLarkTime(Math.floor(startTime / 1000) * 1000)
const searchEnd = formatLarkTime(Math.ceil(endTime / 1000) * 1000)
const output = args.get('output') ?? join('raws', 'lark-im')
const root = join(output, formatZonedTime(startTime).slice(0, 10)); await mkdir(root, { recursive: true })
const summaryPath = join(root, '_updated.md')
// A marker describes only the current attempt. A failed retry must not leave a
// previous successful marker beside partial or stale output.
await rm(summaryPath, { force: true })
const configuredTimeout = Number(process.env.FOLIO_LARK_IM_COMMAND_TIMEOUT_MS)
const commandTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 120_000
const run = (argv) => new Promise((resolve, reject) => {
  // On POSIX, a separate process group lets a timeout terminate helpers spawned
  // by the CLI as well as the CLI itself. Windows uses taskkill for the same
  // process-tree guarantee after giving the direct process a chance to exit.
  const isWindows = process.platform === 'win32'
  const child = spawn('lark-cli', argv, {
    stdio: ['ignore', 'pipe', 'inherit'], detached: !isWindows, windowsHide: true
  })
  let text = ''
  let timedOut = false
  let forceKill
  const signalPosixGroup = signal => {
    try { process.kill(-child.pid, signal) } catch { child.kill(signal) }
  }
  const forceKillTree = () => {
    if (!isWindows) return signalPosixGroup('SIGKILL')
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true
    })
    killer.on('error', () => child.kill('SIGKILL'))
  }
  const timeout = setTimeout(() => {
    timedOut = true
    if (isWindows) forceKillTree()
    else {
      signalPosixGroup('SIGTERM')
      forceKill = setTimeout(forceKillTree, 5_000)
      forceKill.unref()
    }
  }, commandTimeoutMs)
  timeout.unref()
  const clearTimers = () => { clearTimeout(timeout); if (forceKill) clearTimeout(forceKill) }
  child.stdout.on('data', chunk => { text += chunk })
  child.on('error', error => { clearTimers(); reject(error) })
  child.on('close', code => {
    // The direct CLI may exit before a descendant which ignored SIGTERM. Kill
    // the remaining POSIX process group before allowing the extractor to exit.
    if (timedOut && !isWindows) forceKillTree()
    clearTimers()
    if (timedOut) return reject(new Error(`lark-cli timed out after ${commandTimeoutMs}ms`))
    if (code !== 0) return reject(new Error(`lark-cli exited with ${code}`))
    try { resolve(JSON.parse(text)) } catch { reject(new Error('lark-cli returned invalid JSON')) }
  })
})
const envelope = value => value?.data ?? value
const page = (response, label) => {
  const value = envelope(response)
  if (!value || typeof value !== 'object') throw new Error(`Invalid JSON response for ${label}.`)
  return value
}
const pageRows = (value, key, label) => {
  if (!Array.isArray(value[key])) throw new Error(`Invalid ${label} response: missing ${key}.`)
  return value[key]
}
const pagination = value => ({ hasMore: value.has_more === true, token: value.page_token || undefined })

/** Reads every search page explicitly so a page cap cannot silently hide messages. */
const searchMessages = async () => {
  const messages = []; let token; let pageNumber = 0
  do {
    const argv = ['im', '+messages-search', '--as', 'user', '--query', '', '--start', searchStart, '--end', searchEnd,
      '--page-size', '50', '--format', 'json', '--no-reactions']
    if (token) argv.push('--page-token', token)
    const value = page(await run(argv), `messages page ${pageNumber + 1}`)
    messages.push(...pageRows(value, 'messages', 'messages'))
    const next = pagination(value)
    if (next.hasMore && !next.token) throw new Error(`Messages page ${pageNumber + 1} has_more but no page_token.`)
    token = next.token; pageNumber++
    if (pageNumber > 1000) throw new Error('Message pagination exceeded 1000 pages.')
  } while (token)
  return messages.filter(message => {
    const timestamp = parseMessageTime(message.create_time)
    if (!Number.isFinite(timestamp)) throw new Error('Lark message is missing a valid create_time.')
    return timestamp >= startTime && timestamp < endTime
  })
}

/** Queries mute status only for chats present in the message window. */
const readMutedChatIds = async chatIds => {
  const batches = []
  for (let i = 0; i < chatIds.length; i += 10) batches.push(chatIds.slice(i, i + 10))
  const results = []
  let nextBatch = 0
  const worker = async () => {
    while (nextBatch < batches.length) {
      const batch = batches[nextBatch++]
      const response = page(await run([
        'im', 'chat.user_setting', 'batch_query', '--as', 'user',
        '--data', JSON.stringify({ chat_ids: batch }), '--format', 'json'
      ]), `mute status batch ${nextBatch}`)
      results.push(response)
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, batches.length) }, worker))
  const muted = new Set()
  for (const response of results) {
    if (!Array.isArray(response.items)) throw new Error('Invalid mute status response: missing items.')
    for (const item of response.items) if (item?.is_muted === true && item.chat_id) muted.add(item.chat_id)
  }
  return muted
}

const messages = await searchMessages()
const grouped = new Map()
for (const message of messages) {
  const chatId = message.chat_id
  if (!chatId) continue
  const rows = grouped.get(chatId) ?? []
  rows.push(message); grouped.set(chatId, rows)
}
for (const rows of grouped.values()) rows.sort((left, right) => parseMessageTime(left.create_time) - parseMessageTime(right.create_time))
const mutedChatIds = await readMutedChatIds([...grouped.keys()])
const updated = []
let filteredChats = 0
const pendingWrites = []
const singleLine = value => String(value).replace(/\r\n|[\r\n\u2028\u2029]/g, ' ↵ ')
const renderContent = message => {
  if (message.deleted) return '[recalled]'
  const content = typeof message.content === 'string' ? message.content : message.content?.text
  return typeof content === 'string' && content.trim() ? content : `[${message.msg_type ?? 'message'}]`
}
const renderTime = value => { const parsed = parseMessageTime(value); return Number.isFinite(parsed) && parsed > 0 ? formatZonedTime(parsed) : 'unknown time' }
for (const [id, rows] of grouped) {
  if (mutedChatIds.has(id)) { filteredChats++; continue }
  const chat = rows[0]
  const title = chat.chat_name || id
  const metadata = {
    source: 'lark-im', chat_id: id, chat_name: chat.chat_name ?? null,
    chat_description: null, chat_mode: chat.chat_type ?? null,
    owner_id: null, p2p_target_type: null, p2p_target_id: null,
    window_start: start, window_end: end, time_zone: timeZone, message_count: rows.length
  }
  const body = ['---', ...Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`), '---', '', `# ${title}`, '',
    ...rows.map(message => `- ${renderTime(message.create_time)} | ${singleLine(message.sender?.name || 'Unknown')} (${singleLine(message.sender?.id || 'unknown id')}) | ${singleLine(renderContent(message))}`)].join('\n') + '\n'
  pendingWrites.push(writeFile(join(root, `${id}.md`), body))
  updated.push({ id, title, count: rows.length })
}
await Promise.all(pendingWrites)
const summary = [
  '# Lark IM updated chats', '', `Window: ${start} → ${end}`,
  `Searched messages: ${messages.length}`, `Chats found: ${grouped.size}`, `Muted chats skipped: ${filteredChats}`, '',
  ...updated.map(chat => `- [${chat.title}](./${chat.id}.md) — ${chat.count} message(s) — ${chat.id}`)
].join('\n') + '\n'
const stagedSummary = join(root, `._updated-${process.pid}-${Date.now()}.tmp`)
try {
  await writeFile(stagedSummary, summary)
  await rename(stagedSummary, summaryPath)
} finally {
  await rm(stagedSummary, { force: true })
}
