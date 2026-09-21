import { execFile } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const gmail = fileURLToPath(new URL('../src/gmail/assets/workflows/gmail/extract-window.mjs', import.meta.url))
const lark = fileURLToPath(new URL('../src/lark/assets/skills/folio-lark-im/scripts/extract-window.mjs', import.meta.url))
const start = '2026-09-18T00:00:00.500Z'
const end = '2026-09-18T01:00:00.500Z'
const larkStart = '2026-09-21T00:00:00.500+08:00'
const larkEnd = '2026-09-21T01:00:00.500+08:00'
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'folio-extraction-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

/** Execute the shipped file in Node, with all provider I/O supplied by a local fixture. */
async function runGmail(repeatedCursor = false) {
  const preload = join(root, 'gmail-fixture.mjs')
  await writeFile(preload, `
    import assert from 'node:assert/strict'
    const start = ${Date.parse(start)}, end = ${Date.parse(end)}
    globalThis.fetch = async input => {
      const url = new URL(input)
      if (url.pathname.endsWith('/messages')) {
        const q = url.searchParams.get('q')
        assert.ok(q.includes('after:' + (Math.floor(start / 1000) - 1)))
        assert.ok(q.includes('before:' + (Math.ceil(end / 1000) + 1)))
        const page = Number(url.searchParams.get('pageToken') ?? 0)
        const messages = Array.from({ length: page < 2 ? 100 : 3 }, (_, i) => ({ id: String(page * 100 + i) }))
        return Response.json({ messages, nextPageToken: ${repeatedCursor} ? '1' : page < 2 ? String(page + 1) : undefined })
      }
      const id = url.pathname.split('/').at(-1)
      return Response.json({ id, threadId: id,
        internalDate: String(id === '201' ? start - 1 : id === '202' ? end : start),
        payload: { headers: [{ name: 'Subject', value: 'Message ' + id }], mimeType: 'text/plain', body: { data: 'aGVsbG8' } }
      })
    }
  `)
  return execute(process.execPath, ['--import', preload, gmail, '--start', start, '--end', end, '--output', join(root, 'output')], {
    env: { ...process.env, GMAIL_ACCESS_TOKEN: 'fixture' }, timeout: 10_000
  })
}

async function runLark(mode: 'complete' | 'messages-truncated' | 'invalid-json' | 'mute-invalid' | 'timeout' | 'timeout-descendant', chat: Record<string, unknown> = { chat_id: 'oc_fixture', name: 'Fixture' }, messages: readonly Record<string, unknown>[] = [{ create_time: Date.parse(larkStart), content: 'hello' }], timeZone = 'Asia/Shanghai', windowStart = larkStart, windowEnd = larkEnd) {
  const cli = join(root, 'lark-cli')
  const queryStart = new Date(Math.floor(Date.parse(windowStart) / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const queryEnd = new Date(Math.ceil(Date.parse(windowEnd) / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  await writeFile(cli, `#!/usr/bin/env node
    import assert from 'node:assert/strict'
    import { spawn } from 'node:child_process'
    const mode = ${JSON.stringify(mode)}
    const chat = ${JSON.stringify(chat)}
    const messages = ${JSON.stringify(messages)}.map(message => ({
      chat_id: chat.chat_id, chat_name: chat.name, chat_type: chat.chat_mode, ...message
    }))
    if (mode === 'timeout') setInterval(() => {}, 1_000)
    if (mode === 'timeout-descendant') {
      spawn(process.execPath, ['-e', ${JSON.stringify(`
        const { writeFileSync } = require('node:fs')
        process.on('SIGTERM', () => {})
        setTimeout(() => writeFileSync(${JSON.stringify('__DESCENDANT_MARKER__')}, 'orphaned'), 300)
        setInterval(() => {}, 1_000)
      `.replace('__DESCENDANT_MARKER__', join(root, 'descendant-survived')))}], { stdio: 'ignore' })
      setInterval(() => {}, 1_000)
    }
    if (process.argv.includes('+messages-search')) {
      assert.equal(process.argv[process.argv.indexOf('--start') + 1], ${JSON.stringify(queryStart)})
      assert.equal(process.argv[process.argv.indexOf('--end') + 1], ${JSON.stringify(queryEnd)})
      assert.ok(process.argv.includes('--no-reactions'))
      if (mode === 'invalid-json') process.stdout.write('{bad')
      else process.stdout.write(JSON.stringify({ data: {
        messages, has_more: mode === 'messages-truncated'
      } }))
    } else if (process.argv.includes('batch_query')) {
      const data = JSON.parse(process.argv[process.argv.indexOf('--data') + 1])
      process.stdout.write(JSON.stringify({ data: mode === 'mute-invalid' ? {} : {
        items: data.chat_ids.map(chat_id => ({ chat_id, is_muted: false }))
      } }))
    } else {
      throw new Error('Unexpected lark-cli command: ' + process.argv.slice(2).join(' '))
    }
  `)
  await chmod(cli, 0o700)
  return execute(process.execPath, [lark, '--start', windowStart, '--end', windowEnd, '--time-zone', timeZone, '--output', join(root, 'output')], {
    env: { ...process.env, PATH: [root, process.env.PATH ?? ''].join(delimiter),
      ...(mode.startsWith('timeout') ? { FOLIO_LARK_IM_COMMAND_TIMEOUT_MS: '50' } : {}) }, timeout: 10_000
  })
}

describe('bundled extraction workflows', () => {
  it('extracts Gmail beyond 200 messages and applies exact half-open window boundaries', async () => {
    await runGmail()
    const files = await readdir(join(root, 'output/messages'))
    expect(files).toHaveLength(201)
    expect(files).toContain('200.md')
    expect(files).not.toContain('201.md')
    expect(files).not.toContain('202.md')
    expect(await readFile(join(root, 'output/_updated.md'), 'utf8')).toContain('Messages: 201')
  })

  it('fails a repeated Gmail page without publishing a completion summary', async () => {
    await expect(runGmail(true)).rejects.toMatchObject({ stderr: expect.stringContaining('pagination repeated a cursor') })
    await expect(access(join(root, 'output/_updated.md'))).rejects.toThrow()
  })

  it('searches the exact Lark window and publishes only a complete extraction', async () => {
    await runLark('complete', undefined, [
      { create_time: Date.parse(larkEnd), content: 'after' },
      { create_time: Date.parse(larkEnd) - 1, content: 'last' },
      { create_time: Date.parse(larkStart) - 1, content: 'before' },
      { create_time: Date.parse(larkStart), content: 'first' }
    ])
    const summary = await readFile(join(root, 'output/2026-09-21/_updated.md'), 'utf8')
    const chat = await readFile(join(root, 'output/2026-09-21/oc_fixture.md'), 'utf8')
    expect(summary).toContain('Searched messages: 2')
    expect(summary).toContain('2 message(s)')
    expect(chat).toContain('first')
    expect(chat).toContain('last')
    expect(chat).not.toContain('before')
    expect(chat).not.toContain('after')
    expect(chat.indexOf('first')).toBeLessThan(chat.indexOf('last'))
  })

  it.each([
    { chat_id: 'oc_fixture', name: '研发: "项目" #1\n---', description: '第一行\n第二行: 内容', chat_mode: 'group', owner_id: 'ou_owner' },
    { chat_id: 'oc_fixture', name: '同事', chat_mode: 'p2p', p2p_target_type: 'user', p2p_target_id: 'ou_peer' },
    { chat_id: 'oc_fixture' }
  ])('writes chat metadata as safely quoted YAML frontmatter: $chat_id / $chat_mode', async chat => {
    await runLark('complete', chat)
    const content = await readFile(join(root, 'output/2026-09-21/oc_fixture.md'), 'utf8')
    const parts = content.split('---\n')
    expect(parts[0]).toBe('')
    // The extractor emits YAML's JSON-compatible scalar subset. Decode each
    // value to verify special characters round-trip without injecting fields.
    const metadata = Object.fromEntries(parts[1]!.trimEnd().split('\n').map(line => {
      const separator = line.indexOf(': ')
      return [line.slice(0, separator), JSON.parse(line.slice(separator + 2))]
    }))
    expect(metadata).toEqual({
      source: 'lark-im', chat_id: chat.chat_id, chat_name: chat.name ?? null,
      chat_description: null,
      chat_mode: chat.chat_mode ?? null, owner_id: null,
      p2p_target_type: null, p2p_target_id: null,
      window_start: larkStart, window_end: larkEnd, time_zone: 'Asia/Shanghai', message_count: 1
    })
    expect(content).toContain('hello')
    expect(content).not.toContain('- chat_id:')
  })

  it('renders one readable line per message with sender name, ID, time and content', async () => {
    const sender = { name: '张三', id: 'ou_zhang' }
    await runLark('complete', undefined, [
      { create_time: Date.parse(larkStart), sender, content: '第一行\r\n第二行\n第三行' },
      { create_time: larkStart, sender, msg_type: 'post', content: '**更新** [文档](https://example.com)' },
      { create_time: larkStart, sender, msg_type: 'image', content: '![Image](img_fixture)' },
      { create_time: larkStart, sender, msg_type: 'file', content: null },
      { create_time: larkStart, content: { text: '系统通知' } },
      { create_time: larkStart, sender, deleted: true, content: '撤回的内容' }
    ])
    const content = await readFile(join(root, 'output/2026-09-21/oc_fixture.md'), 'utf8')
    const body = content.split('\n---\n')[1]!
    expect(body.trim().split('\n')).toEqual([
      '# Fixture', '',
      `- ${larkStart} | 张三 (ou_zhang) | 第一行 ↵ 第二行 ↵ 第三行`,
      `- ${larkStart} | 张三 (ou_zhang) | **更新** [文档](https://example.com)`,
      `- ${larkStart} | 张三 (ou_zhang) | ![Image](img_fixture)`,
      `- ${larkStart} | 张三 (ou_zhang) | [file]`,
      `- ${larkStart} | Unknown (unknown id) | 系统通知`,
      `- ${larkStart} | 张三 (ou_zhang) | [recalled]`
    ])
    expect(body).not.toContain('```json')
  })

  it('renders each message with the active Routine-zone offset across a DST transition', async () => {
    const windowStart = '2026-11-01T01:30:00.000-04:00'
    const windowEnd = '2026-11-01T01:30:00.000-05:00'
    await runLark('complete', undefined, [
      { create_time: Date.parse(windowStart), content: 'before fallback' },
      { create_time: Date.parse(windowEnd) - 1, content: 'after fallback' }
    ], 'America/New_York', windowStart, windowEnd)
    const content = await readFile(join(root, 'output/2026-11-01/oc_fixture.md'), 'utf8')
    expect(content).toContain('- 2026-11-01T01:30:00.000-04:00 |')
    expect(content).toContain('- 2026-11-01T01:29:59.999-05:00 |')
  })

  it.each(['messages-truncated', 'invalid-json', 'mute-invalid', 'timeout'] as const)('rejects Lark %s without a completion summary', async mode => {
    const directory = join(root, 'output/2026-09-21')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, '_updated.md'), 'stale successful marker')
    await expect(runLark(mode)).rejects.toMatchObject({ stderr: expect.stringContaining(
      mode === 'invalid-json' ? 'invalid JSON' : mode === 'messages-truncated' ? 'has_more but no page_token'
        : mode === 'mute-invalid' ? 'missing items' : 'timed out') })
    await expect(access(join(root, 'output/2026-09-18/_updated.md'))).rejects.toThrow()
  })

  it('terminates descendants when a Lark command times out', async () => {
    await expect(runLark('timeout-descendant')).rejects.toMatchObject({
      stderr: expect.stringContaining('timed out')
    })
    await delay(500)
    await expect(access(join(root, 'descendant-survived'))).rejects.toThrow()
  })
})
