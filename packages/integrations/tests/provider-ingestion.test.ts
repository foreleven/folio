import { NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  gmailCredentials: vi.fn(),
  runCli: vi.fn(),
  imapClose: vi.fn(),
  imapLogout: vi.fn()
}))

vi.mock('../src/gmail/oauth.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/gmail/oauth.ts')>(),
  maintainCredentials: mocks.gmailCredentials
}))
vi.mock('../src/lark/cli.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lark/cli.ts')>(),
  runCli: mocks.runCli
}))
vi.mock('imapflow', () => ({
  ImapFlow: class {
    on(): void {}
    connect = async (): Promise<void> => undefined
    mailboxOpen = async (): Promise<{ uidValidity: bigint }> => ({ uidValidity: 7n })
    search = async (): Promise<number[]> => [42]
    fetchAll = async (): Promise<Array<{ uid: number; internalDate: Date; size: number }>> => [{ uid: 42, internalDate: new Date('2026-09-21T00:10:00.000Z'), size: 100 }]
    fetchOne = async (): Promise<{ uid: number; source: Buffer }> => ({ uid: 42, source: Buffer.from('From: Alice <alice@example.com>\r\nTo: Bob <bob@example.com>\r\nSubject: Status\r\nMessage-ID: <fixture@example.com>\r\n\r\nReady to ship.') })
    logout = mocks.imapLogout
    close = mocks.imapClose
  }
}))

import { ingestGmail } from '../src/gmail/ingest.ts'
import { ingestImap } from '../src/imap/ingest.ts'
import { ingestLarkIm } from '../src/lark/ingest.ts'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'folio-provider-ingestion-'))
  mocks.gmailCredentials.mockReset().mockReturnValue(Effect.succeed({ accessToken: 'access-token' }))
  mocks.runCli.mockReset()
  mocks.imapClose.mockReset()
  mocks.imapLogout.mockReset().mockResolvedValue(undefined)
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(root, { recursive: true, force: true })
})

const window = { start: Date.parse('2026-09-21T00:00:00.000Z'), end: Date.parse('2026-09-21T01:00:00.000Z'), timeZone: 'Asia/Shanghai' }

describe('provider-hosted ingestion', () => {
  it('writes only Gmail messages inside the exact half-open window', async () => {
    const details: Record<string, unknown> = {
      inside: { id: 'inside', threadId: 'thread', internalDate: String(window.start + 1), labelIds: ['INBOX'], payload: {
        headers: [{ name: 'Subject', value: 'Daily update' }, { name: 'From', value: 'Alice' }],
        mimeType: 'text/plain', body: { data: Buffer.from('Ship it').toString('base64url') }
      } },
      end: { id: 'end', internalDate: String(window.end), payload: { headers: [] } }
    }
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/messages?')) return new Response(JSON.stringify({ messages: [{ id: 'inside' }, { id: 'end' }] }))
      const id = decodeURIComponent(url.match(/\/messages\/([^?]+)/)?.[1] ?? '')
      return new Response(JSON.stringify(details[id]))
    }))
    const outputDirectory = join(root, 'gmail')
    await Effect.runPromise(ingestGmail({ integrationDirectory: root, outputDirectory, window }).pipe(Effect.provide(NodeServices.layer)))
    expect(await readdir(outputDirectory)).toEqual(['inside.md'])
    expect(await readFile(join(outputDirectory, 'inside.md'), 'utf8')).toContain('time_zone: "Asia/Shanghai"')
  })

  it('normalizes Lark epoch seconds and writes frontmatter plus one compact line per message', async () => {
    const integrationDirectory = join(root, 'lark')
    await mkdir(integrationDirectory, { recursive: true })
    await writeFile(join(integrationDirectory, 'private.json'), JSON.stringify({
      version: 1, installed: true,
      app: { clientId: 'app', clientSecret: 'secret', brand: 'feishu' },
      userAuth: { clientId: 'app', brand: 'feishu', accessToken: 'token', expiresAt: Date.now() + 60_000, openId: 'ou_me' }
    }))
    mocks.runCli.mockReturnValue(Effect.succeed(JSON.stringify({ data: { messages: [{
      message_id: 'om_1', chat_id: 'oc_1', chat_name: 'Release Team', chat_type: 'group',
      create_time: String((window.start + 10_000) / 1000), sender: { id: 'ou_alice', name: 'Alice' },
      msg_type: 'text', content: { text: 'Ready\nfor release' }, deleted: false
    }], has_more: false } })))
    const outputDirectory = join(root, 'lark-output')
    await Effect.runPromise(ingestLarkIm({ integrationDirectory, outputDirectory, window }).pipe(Effect.provide(NodeServices.layer)))
    const projection = await readFile(join(outputDirectory, 'oc_1.md'), 'utf8')
    expect(projection).toContain('chat_name: "Release Team"')
    expect(projection).toContain('2026-09-21 08:00:10 | Alice (ou_alice) | om_1 | Ready ↵ for release')
    expect(projection).not.toContain('"sender"')
  })

  it('writes stable IMAP projections directly and always closes the client', async () => {
    const integrationDirectory = join(root, 'imap')
    await mkdir(integrationDirectory, { recursive: true })
    await writeFile(join(integrationDirectory, 'private.json'), JSON.stringify({
      version: 1, installed: true,
      credentials: { host: 'imap.example.com', port: 993, security: 'tls', user: 'person@example.com', password: 'secret', mailbox: 'INBOX', verified: true }
    }))
    const outputDirectory = join(root, 'imap-output')
    await Effect.runPromise(ingestImap({ integrationDirectory, outputDirectory, window }).pipe(Effect.provide(NodeServices.layer)))
    const files = await readdir(outputDirectory)
    expect(files).toHaveLength(1)
    expect(await readFile(join(outputDirectory, files[0]!), 'utf8')).toContain('Ready to ship.')
    expect(mocks.imapLogout).toHaveBeenCalledOnce()
    expect(mocks.imapClose).toHaveBeenCalledOnce()
  })
})
