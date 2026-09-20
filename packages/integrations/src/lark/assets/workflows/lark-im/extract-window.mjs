#!/usr/bin/env node
/** Extract one complete Lark IM window into workspace raws for a Routine run. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1])
const start = args.get('start'); const end = args.get('end')
if (!start || !end) throw new Error('Usage: extract-window.mjs --start <ISO> --end <ISO> [--output raws/lark-im]')
const startTime = Date.parse(start); const endTime = Date.parse(end)
if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) throw new Error('The extraction window must contain valid ISO timestamps with end after start.')
const output = args.get('output') ?? join('raws', 'lark-im')
const run = (argv) => new Promise((resolve, reject) => {
  const child = spawn('lark-cli', argv, { stdio: ['ignore', 'pipe', 'inherit'] })
  let text = ''
  child.stdout.on('data', chunk => { text += chunk })
  child.on('error', reject)
  child.on('close', code => {
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
    const argv = ['im', '+messages-search', '--as', 'user', '--query', '', '--start', start, '--end', end, '--page-size', '50', '--format', 'json']
    if (token) argv.push('--page-token', token)
    const value = page(await run(argv), `messages page ${pageNumber + 1}`)
    messages.push(...pageRows(value, 'messages', 'messages'))
    const next = pagination(value)
    if (next.hasMore && !next.token) throw new Error(`Messages page ${pageNumber + 1} has_more but no page_token.`)
    token = next.token; pageNumber++
    if (pageNumber > 1000) throw new Error('Message pagination exceeded 1000 pages.')
  } while (token)
  return messages
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
const mutedChatIds = await readMutedChatIds([...grouped.keys()])
const root = join(output, start.slice(0, 10)); await mkdir(root, { recursive: true }); const updated = []
let filteredChats = 0
const pendingWrites = []
const singleLine = value => String(value).replace(/\r\n|[\r\n\u2028\u2029]/g, ' ↵ ')
const renderContent = message => {
  if (message.deleted) return '[recalled]'
  const content = typeof message.content === 'string' ? message.content : message.content?.text
  return typeof content === 'string' && content.trim() ? content : `[${message.msg_type ?? 'message'}]`
}
const renderTime = value => { const parsed = typeof value === 'string' && !/^\d+$/.test(value) ? Date.parse(value) : Number(value); return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed).toISOString() : 'unknown time' }
for (const [id, rows] of grouped) {
  if (mutedChatIds.has(id)) { filteredChats++; continue }
  const chat = rows[0]
  const title = chat.chat_name || id
  const metadata = {
    source: 'lark-im', chat_id: id, chat_name: chat.chat_name ?? null,
    chat_description: null, chat_mode: chat.chat_type ?? null,
    owner_id: null, p2p_target_type: null, p2p_target_id: null,
    window_start: start, window_end: end, message_count: rows.length
  }
  const body = ['---', ...Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`), '---', '', `# ${title}`, '',
    ...rows.map(message => `- ${renderTime(message.create_time)} | ${singleLine(message.sender?.name || 'Unknown')} (${singleLine(message.sender?.id || 'unknown id')}) | ${singleLine(renderContent(message))}`)].join('\n') + '\n'
  pendingWrites.push(writeFile(join(root, `${id}.md`), body))
  updated.push({ id, title, count: rows.length })
}
await Promise.all(pendingWrites)
await writeFile(join(root, '_updated.md'), [
  '# Lark IM updated chats', '', `Window: ${start} → ${end}`,
  `Searched messages: ${messages.length}`, `Chats found: ${grouped.size}`, `Muted chats skipped: ${filteredChats}`, '',
  ...updated.map(chat => `- [${chat.title}](./${chat.id}.md) — ${chat.count} message(s) — ${chat.id}`)
].join('\n') + '\n')
