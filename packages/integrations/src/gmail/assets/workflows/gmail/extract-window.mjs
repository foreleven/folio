#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const argument = (name) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const start = argument('--start')
const end = argument('--end')
const output = argument('--output')
if (!start || !end || !output) throw new Error('Usage: extract-window.mjs --start <ISO> --end <ISO> --output <directory>')
const startTime = Date.parse(start)
const endTime = Date.parse(end)
if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) throw new Error('Invalid extraction window')
const token = process.env.GMAIL_ACCESS_TOKEN
if (!token) throw new Error('GMAIL_ACCESS_TOKEN is not available')

const api = async (path, options = {}) => {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    ...options,
    signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${token}`, ...(options.headers ?? {}) }
  })
  if (!response.ok) throw new Error(`Gmail API request failed (${response.status})`)
  return response.json()
}
// Gmail search has second precision. Fetch a covering range, then apply the
// exact [start, end) millisecond window to avoid gaps between Routine runs.
const query = `after:${Math.floor(startTime / 1000) - 1} before:${Math.ceil(endTime / 1000) + 1}`
const ids = new Set()
const pages = new Set()
let pageToken
do {
  const params = new URLSearchParams({ q: query, maxResults: '100' })
  if (pageToken) params.set('pageToken', pageToken)
  const page = await api(`messages?${params}`)
  for (const message of page.messages ?? []) ids.add(message.id)
  pageToken = page.nextPageToken
  if (pageToken && pages.has(pageToken)) throw new Error('Gmail pagination repeated a cursor; the extraction window is incomplete')
  if (pageToken) pages.add(pageToken)
} while (pageToken)

const messages = []
for (const id of ids) {
  const message = await api(`messages/${encodeURIComponent(id)}?format=full`)
  const receivedAt = Number(message.internalDate)
  if (!Number.isFinite(receivedAt)) throw new Error('Gmail returned an invalid message timestamp')
  if (receivedAt < startTime || receivedAt >= endTime) continue
  const headers = Object.fromEntries((message.payload?.headers ?? []).map((header) => [header.name.toLowerCase(), header.value]))
  const body = []
  const visit = (part) => {
    if (part?.mimeType === 'text/plain' && part.body?.data) body.push(Buffer.from(part.body.data, 'base64url').toString('utf8'))
    for (const child of part?.parts ?? []) visit(child)
  }
  visit(message.payload)
  messages.push({
    id: message.id,
    threadId: message.threadId,
    internalDate: receivedAt,
    labels: message.labelIds ?? [],
    from: headers.from ?? '',
    to: headers.to ?? '',
    subject: headers.subject ?? '(no subject)',
    body: body.join('\n\n').trim()
  })
}
messages.sort((left, right) => left.internalDate - right.internalDate)
await mkdir(join(output, 'messages'), { recursive: true })
for (const message of messages) {
  const safeId = message.id.replace(/[^a-zA-Z0-9_-]/g, '_')
  const content = [
    `# ${message.subject}`,
    '',
    `- From: ${message.from}`,
    `- To: ${message.to}`,
    `- Received: ${new Date(message.internalDate).toISOString()}`,
    `- Gmail labels: ${message.labels.join(', ') || '(none)'}`,
    `- Thread: ${message.threadId}`,
    '',
    message.body || '(empty body)',
    ''
  ].join('\n')
  await writeFile(join(output, 'messages', `${safeId}.md`), content, { mode: 0o600 })
}
const updated = [
  `# Gmail messages updated`,
  '',
  `Window: ${new Date(startTime).toISOString()} → ${new Date(endTime).toISOString()}`,
  `Messages: ${messages.length}`,
  '',
  ...messages.map((message) => `- [${message.subject}](messages/${message.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.md) — ${message.from}`),
  ''
].join('\n')
await writeFile(join(output, '_updated.md'), updated, { mode: 0o600 })
