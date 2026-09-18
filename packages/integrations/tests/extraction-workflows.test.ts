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

async function runLark(mode: 'complete' | 'chat-truncated' | 'messages-truncated' | 'invalid-json') {
  const cli = join(root, 'lark-cli')
  await writeFile(cli, `#!/usr/bin/env node
    import assert from 'node:assert/strict'
    const mode = ${JSON.stringify(mode)}
    assert.ok(process.argv.includes('--page-all'))
    if (mode === 'invalid-json') process.stdout.write('{bad')
    else if (process.argv.includes('+chat-list')) {
      process.stdout.write(JSON.stringify({ data: { chats: [{ chat_id: 'oc_fixture', name: 'Fixture' }] },
        meta: { pagination: { complete: mode !== 'chat-truncated' } } }))
    } else {
      process.stdout.write(JSON.stringify({ data: { messages: [{ create_time: ${Date.parse(start)}, content: 'hello' }] },
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

  it.each(['chat-truncated', 'messages-truncated', 'invalid-json'] as const)('rejects Lark %s without a completion summary', async mode => {
    await expect(runLark(mode)).rejects.toMatchObject({ stderr: expect.stringContaining(mode === 'invalid-json' ? 'invalid JSON' : 'Pagination did not complete') })
    await expect(access(join(root, 'output/2026-09-18/_updated.md'))).rejects.toThrow()
  })
})
