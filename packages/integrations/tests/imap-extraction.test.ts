import { execFile } from 'node:child_process'
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const require = createRequire(import.meta.url)
const extractor = fileURLToPath(new URL('../src/imap/assets/workflows/imap/extract-window.mjs', import.meta.url))
const start = '2026-09-18T00:00:00.500Z', end = '2026-09-18T01:00:00.500Z'
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'folio-imap-extraction-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

/** Run the shipped, relocated script with an IMAP fixture and the actual MIME parser. */
async function run(mode = 'complete', validity = '1', user = 'person@example.test') {
  const fixture = join(root, 'imap-fixture.cjs')
  const script = join(root, 'extract-window.mjs')
  await copyFile(extractor, script)
  await writeFile(fixture, `
    const assert = require('node:assert/strict')
    const fs = require('node:fs')
    const mode = ${JSON.stringify(mode)}
    const start = ${Date.parse(start)}, end = ${Date.parse(end)}
    exports.ImapFlow = class {
      constructor(options) {
        assert.equal(options.secure, true)
        assert.equal(options.logger, false)
      }
      on() {}
      async connect() { if (mode === 'connect-failure') throw Error('PRIVATE_PASSWORD') }
      async mailboxOpen(path, options) {
        assert.equal(path, 'INBOX')
        assert.equal(options.readOnly, true)
        return { uidValidity: BigInt(${JSON.stringify(validity)}) }
      }
      async search(query, options) {
        assert.deepEqual(query, { since: '2026-09-17', before: '2026-09-19' })
        assert.equal(options.uid, true)
        if (mode === 'search-failure') return false
        if (mode === 'empty') return []
        return [...Array.from({ length: 203 }, (_, i) => i + 1), 1]
      }
      async fetchAll(batch, query, options) {
        assert.ok(batch.length <= 100)
        assert.equal(query.internalDate, true)
        assert.equal(query.source, undefined)
        assert.equal(options.uid, true)
        if (mode === 'missing-message') return []
        return batch.map(uid => ({ uid, internalDate: mode === 'invalid-date' ? undefined
          : new Date(uid === 202 ? start - 1 : uid === 203 ? end : start),
          size: mode === 'oversize' ? 26 * 1024 * 1024 : 200 }))
      }
      async fetchOne(uid, query, options) {
        assert.equal(options.uid, true)
        assert.equal(query.source, true)
        assert.ok(uid <= 201, 'Do not download bodies outside the exact window')
        if (mode === 'partial' && uid === 101) throw Error('PRIVATE_PASSWORD')
        if (mode === 'missing-body') return false
        return { uid, source: Buffer.from([
          'From: Sender <sender@example.test>', 'To: person@example.test',
          'Subject: =?UTF-8?B?5rWL6K+V?=', 'Message-ID: <' + uid + '@example.test>',
          'MIME-Version: 1.0',
          ...((mode.startsWith('multipart/') || mode === 'plain-preferred') ? [
            'Content-Type: ' + (mode === 'plain-preferred' ? 'multipart/alternative' : mode) + '; boundary="body-boundary"', '', '--body-boundary'
          ] : []),
          ...(mode === 'plain-preferred' ? [
            'Content-Type: text/plain; charset=utf-8', '', 'Authored plain body', '--body-boundary'
          ] : []),
          'Content-Type: text/html; charset=utf-8',
          'Content-Transfer-Encoding: base64', '',
          Buffer.from(mode === 'empty-body' ? '' : '<style>.hidden{color:red}</style><script>secretScript()</script><p>Hello <b>世界</b></p>').toString('base64'),
          ...((mode.startsWith('multipart/') || mode === 'plain-preferred') ? ['', '--body-boundary--'] : [])
        ].join('\\r\\n')) }
      }
      async logout() {}
      close() { fs.writeFileSync(${JSON.stringify(join(root, 'closed'))}, 'closed') }
    }
  `)
  return execute(process.execPath, [script, '--start', start, '--end', end, '--output', join(root, 'output')], {
    cwd: root, timeout: 20_000,
    env: { ...process.env, IMAPFLOW_MODULE_PATH: fixture, IMAP_MAILPARSER_MODULE_PATH: require.resolve('mailparser'),
      IMAP_HTML_TO_TEXT_MODULE_PATH: require.resolve('html-to-text'),
      IMAP_CONNECTION: JSON.stringify({ host: 'imap.example.test', port: 993, user, password: 'PRIVATE_PASSWORD',
        security: 'tls', mailbox: 'INBOX' }) }
  })
}

describe('IMAP extraction workflow', () => {
  it('extracts more than 200 messages, deduplicates UIDs, enforces exact boundaries and decodes HTML/MIME', async () => {
    const result = await run()
    expect(result.stdout).toContain('"candidateCount":203')
    expect(result.stdout).toContain('"messageCount":201')
    expect(result.stdout).toContain('"windowStart":"2026-09-18T00:00:00.500Z"')
    expect(result.stdout).not.toContain('PRIVATE_PASSWORD')
    expect(result.stdout).not.toContain('sender@example.test')
    const files = await readdir(join(root, 'output/messages'))
    expect(files).toHaveLength(201)
    const content = await readFile(join(root, 'output/messages', files[0]!), 'utf8')
    expect(content).toContain('# 测试')
    expect(content).toContain('Hello 世界')
    expect(content).not.toContain('<p>')
    expect(content).not.toContain('PRIVATE_PASSWORD')
    expect(await readFile(join(root, 'output/_updated.md'), 'utf8')).toContain('Messages: 201')
    expect(await readFile(join(root, 'closed'), 'utf8')).toBe('closed')
  })

  it.each(['multipart/alternative', 'multipart/mixed'])('extracts HTML-only %s bodies', async mode => {
    await run(mode)
    const files = await readdir(join(root, 'output/messages'))
    const content = await readFile(join(root, 'output/messages', files[0]!), 'utf8')
    expect(content).toContain('Hello 世界')
    expect(content).not.toContain('(empty body)')
    expect(content).not.toContain('<p>')
    expect(content).not.toContain('secretScript')
    expect(content).not.toContain('color:red')
  })

  it.each([
    ['plain-preferred', 'Authored plain body'],
    ['empty-body', '(empty body)']
  ])('preserves %s behavior', async (mode, body) => {
    await run(mode)
    const files = await readdir(join(root, 'output/messages'))
    const content = await readFile(join(root, 'output/messages', files[0]!), 'utf8')
    expect(content).toContain(body)
    expect(content).not.toContain('Hello 世界')
  })

  it('publishes an empty result only after a successful empty search', async () => {
    await run('empty')
    expect(await readFile(join(root, 'output/_updated.md'), 'utf8')).toContain('Messages: 0')
  })

  it.each(['connect-failure', 'search-failure', 'partial', 'missing-message', 'missing-body', 'invalid-date', 'oversize'])(
    'rejects %s, closes the connection and removes stale success markers without exposing secrets', async mode => {
      await mkdir(join(root, 'output'))
      await writeFile(join(root, 'output/_updated.md'), 'previous success')
      await expect(run(mode)).rejects.toMatchObject({ stderr: expect.stringContaining('window is incomplete') })
      await expect(access(join(root, 'output/_updated.md'))).rejects.toThrow()
      expect(await readFile(join(root, 'closed'), 'utf8')).toBe('closed')
      try { await run(mode) } catch (error) {
        const stderr = (error as { stderr: string }).stderr
        expect(stderr).not.toContain('PRIVATE_PASSWORD')
        expect(stderr).toContain('"status":"failed"')
        if (mode === 'connect-failure') expect(stderr).toContain('"stage":"connect"')
        if (mode === 'partial') expect(stderr).toContain('"stage":"fetch-body"')
      }
    })

  it('namespaces message files by UIDVALIDITY and account to avoid overwriting unrelated mail', async () => {
    await run()
    await run('complete', '2')
    await run('complete', '2', 'another@example.test')
    expect(await readdir(join(root, 'output/messages'))).toHaveLength(603)
  })
})
