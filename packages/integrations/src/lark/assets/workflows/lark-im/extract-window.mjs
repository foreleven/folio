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
const run = (argv) => new Promise((resolve, reject) => { const child = spawn('lark-cli', argv, { stdio: ['ignore', 'pipe', 'inherit'] }); let text = ''; child.stdout.on('data', chunk => { text += chunk }); child.on('error', reject); child.on('close', code => code === 0 ? resolve(JSON.parse(text)) : reject(new Error(`lark-cli exited with ${code}`))) })
const envelope = value => value?.data ?? value
const chats = envelope(await run(['im', '+chat-list', '--as', 'user', '--types', 'p2p,group', '--sort', 'active_time', '--exclude-muted', '--page-size', '100', '--format', 'json']))?.chats ?? []
const root = join(output, start.slice(0, 10)); await mkdir(root, { recursive: true }); const updated = []
const renderContent = content => typeof content === 'string' ? content : content == null ? '' : JSON.stringify(content, null, 2)
const renderTime = value => { const parsed = typeof value === 'string' && !/^\d+$/.test(value) ? Date.parse(value) : Number(value); return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed).toISOString() : 'unknown time' }
for (const chat of chats) {
  const id = chat.chat_id
  if (!/^oc_[A-Za-z0-9_-]+$/.test(id ?? '')) continue
  const result = envelope(await run(['im', '+chat-messages-list', '--as', 'user', '--chat-id', id, '--start', start, '--end', end, '--order', 'asc', '--page-all', '--page-limit', '1000', '--format', 'json']))
  if (result?.has_more === true || result?.meta?.pagination?.complete === false) throw new Error(`Message pagination did not complete for ${id}. Increase the page limit or retry the window.`)
  const rows = result?.messages ?? []
  if (!rows.length) continue
  const title = chat.name || chat.description || id
  const body = [
    `# ${title}`, '', `- chat_id: ${id}`, `- window: ${start} → ${end}`, '',
    ...rows.map(message => `## ${renderTime(message.create_time)} · ${message.sender?.name || message.sender?.id || 'Unknown'}\n\n${renderContent(message.content) || `[${message.msg_type ?? 'message'}]`}\n\n\`\`\`json\n${JSON.stringify(message, null, 2)}\n\`\`\``)
  ].join('\n') + '\n'
  await writeFile(join(root, `${id}.md`), body)
  updated.push({ id, title, count: rows.length })
}
await writeFile(join(root, '_updated.md'), [`# Lark IM updated chats`, '', `Window: ${start} → ${end}`, '', ...updated.map(chat => `- [${chat.title}](./${chat.id}.md) — ${chat.count} message(s) — ${chat.id}`)].join('\n') + '\n')
