import { execFile } from 'node:child_process'
import { access, chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const gmail = fileURLToPath(new URL('../src/gmail/assets/workflows/gmail/extract-window.mjs', import.meta.url))
const lark = fileURLToPath(new URL('../src/lark/assets/workflows/lark-im/extract-window.mjs', import.meta.url))
const start = '2026-09-18T00:00:00.500Z'
const end = '2026-09-18T01:00:00.500Z'
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

async function runLark(mode: 'complete' | 'chat-truncated' | 'messages-truncated' | 'invalid-json', chat: Record<string, unknown> = { chat_id: 'oc_fixture', name: 'Fixture' }, messages: readonly Record<string, unknown>[] = [{ create_time: Date.parse(start), content: 'hello' }]) {
  const cli = join(root, 'lark-cli')
  await writeFile(cli, `#!/usr/bin/env node
    import assert from 'node:assert/strict'
    const mode = ${JSON.stringify(mode)}
    assert.ok(process.argv.includes('--page-all'))
    if (mode === 'invalid-json') process.stdout.write('{bad')
    else if (process.argv.includes('+chat-list')) {
      process.stdout.write(JSON.stringify({ data: { chats: [${JSON.stringify(chat)}] },
        meta: { pagination: { complete: mode !== 'chat-truncated' } } }))
    } else {
      process.stdout.write(JSON.stringify({ data: { messages: ${JSON.stringify(messages)} },
        meta: { pagination: { complete: mode !== 'messages-truncated' } } }))
    }
  `)
  await chmod(cli, 0o700)
  return execute(process.execPath, [lark, '--start', start, '--end', end, '--output', join(root, 'output')], {
    env: { ...process.env, PATH: [root, process.env.PATH ?? ''].join(delimiter) }, timeout: 10_000
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

  it('requests all Lark chat pages and publishes only a complete extraction', async () => {
    await runLark('complete')
    expect(await readFile(join(root, 'output/2026-09-18/_updated.md'), 'utf8')).toContain('1 message(s)')
  })

  it.each([
    { chat_id: 'oc_fixture', name: '研发: "项目" #1\n---', description: '第一行\n第二行: 内容', chat_mode: 'group', owner_id: 'ou_owner' },
    { chat_id: 'oc_fixture', name: '同事', chat_mode: 'p2p', p2p_target_type: 'user', p2p_target_id: 'ou_peer' },
    { chat_id: 'oc_fixture' }
  ])('writes chat metadata as safely quoted YAML frontmatter: $chat_id / $chat_mode', async chat => {
    await runLark('complete', chat)
    const content = await readFile(join(root, 'output/2026-09-18/oc_fixture.md'), 'utf8')
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
      chat_description: 'description' in chat ? chat.description : null,
      chat_mode: chat.chat_mode ?? null, owner_id: 'owner_id' in chat ? chat.owner_id : null,
      p2p_target_type: 'p2p_target_type' in chat ? chat.p2p_target_type : null,
      p2p_target_id: 'p2p_target_id' in chat ? chat.p2p_target_id : null,
      window_start: start, window_end: end, message_count: 1
    })
    expect(content).toContain('hello')
    expect(content).not.toContain('- chat_id:')
  })

  it('renders one readable line per message with sender name, ID, time and content', async () => {
    const sender = { name: '张三', id: 'ou_zhang' }
    await runLark('complete', undefined, [
      { create_time: Date.parse(start), sender, content: '第一行\r\n第二行\n第三行' },
      { create_time: start, sender, msg_type: 'post', content: '**更新** [文档](https://example.com)' },
      { create_time: start, sender, msg_type: 'image', content: '![Image](img_fixture)' },
      { create_time: start, sender, msg_type: 'file', content: null },
      { create_time: start, content: { text: '系统通知' } },
      { create_time: start, sender, deleted: true, content: '撤回的内容' }
    ])
    const content = await readFile(join(root, 'output/2026-09-18/oc_fixture.md'), 'utf8')
    const body = content.split('\n---\n')[1]!
    expect(body.trim().split('\n')).toEqual([
      '# Fixture', '',
      `- ${start} | 张三 (ou_zhang) | 第一行 ↵ 第二行 ↵ 第三行`,
      `- ${start} | 张三 (ou_zhang) | **更新** [文档](https://example.com)`,
      `- ${start} | 张三 (ou_zhang) | ![Image](img_fixture)`,
      `- ${start} | 张三 (ou_zhang) | [file]`,
      `- ${start} | Unknown (unknown id) | 系统通知`,
      `- ${start} | 张三 (ou_zhang) | [recalled]`
    ])
    expect(body).not.toContain('```json')
  })

  it.each(['chat-truncated', 'messages-truncated', 'invalid-json'] as const)('rejects Lark %s without a completion summary', async mode => {
    await expect(runLark(mode)).rejects.toMatchObject({ stderr: expect.stringContaining(mode === 'invalid-json' ? 'invalid JSON' : 'Pagination did not complete') })
    await expect(access(join(root, 'output/2026-09-18/_updated.md'))).rejects.toThrow()
  })
})
