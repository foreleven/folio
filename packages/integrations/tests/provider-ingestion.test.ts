import { NodeServices } from '@effect/platform-node'
import { Effect, Logger } from 'effect'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  gmailCredentials: vi.fn(),
  openCli: vi.fn(),
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
  openCli: mocks.openCli,
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
import { ingestLarkEmail, ingestLarkIm } from '../src/lark/ingest.ts'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'folio-provider-ingestion-'))
  mocks.gmailCredentials.mockReset().mockReturnValue(Effect.succeed({ accessToken: 'access-token' }))
  mocks.openCli.mockReset().mockImplementation(directory => Effect.succeed({
    run: (args: readonly string[], token: string, environment?: Readonly<Record<string, string>>) =>
      mocks.runCli(directory, args, token, environment)
  }))
  mocks.runCli.mockReset()
  mocks.imapClose.mockReset()
  mocks.imapLogout.mockReset().mockResolvedValue(undefined)
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(root, { recursive: true, force: true })
})

const window = { start: Date.parse('2026-09-21T00:00:00.000Z'), end: Date.parse('2026-09-21T01:00:00.000Z'), timeZone: 'Asia/Shanghai' }

const prepareLarkIntegration = async (name: string): Promise<string> => {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'private.json'), JSON.stringify({
    version: 1, installed: true,
    app: { clientId: 'app', clientSecret: 'secret', brand: 'feishu' },
    userAuth: { clientId: 'app', brand: 'feishu', accessToken: 'token', expiresAt: Date.now() + 60_000, openId: 'ou_me' }
  }))
  return directory
}

describe('provider-hosted ingestion', () => {
  it('logs the mail decode failure stage without including response content', async () => {
    const integrationDirectory = await prepareLarkIntegration('lark-invalid-mail')
    mocks.runCli.mockReturnValue(Effect.succeed(JSON.stringify({ data: { messages: 'private-mail-content' } })))
    const logs: unknown[] = []
    await Effect.runPromise(ingestLarkEmail({ integrationDirectory, outputDirectory: join(root, 'mail'), window }).pipe(
      Effect.flip, Effect.provide(NodeServices.layer),
      Effect.provide(Logger.layer([Logger.make(({ message }) => { logs.push(message) })]))
    ))
    const output = JSON.stringify(logs)
    expect(output).toContain('decode-summaries')
    expect(output).toContain('Lark returned invalid mail summaries.')
    expect(output).not.toContain('private-mail-content')
  })

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
    const integrationDirectory = await prepareLarkIntegration('lark')
    mocks.runCli.mockImplementation((_directory, args) => Effect.succeed(JSON.stringify(args[1] === 'chat.user_setting'
      ? { data: { items: [{ chat_id: 'oc_1', is_muted: false }] } }
      : { data: { messages: [{
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

  it('excludes muted Lark chats and removes their existing daily projection', async () => {
    const integrationDirectory = await prepareLarkIntegration('lark-muted')
    mocks.runCli.mockImplementation((_directory, args) => Effect.succeed(JSON.stringify(args[1] === 'chat.user_setting'
      ? { data: { items: [{ chat_id: 'oc_muted', is_muted: true }, { chat_id: 'oc_visible', is_muted: false }] } }
      : { data: { messages: [
        { message_id: 'om_muted', chat_id: 'oc_muted', chat_name: 'Muted', chat_type: 'group',
          create_time: String((window.start + 10_000) / 1000), sender: { id: 'ou_muted', name: 'Muted sender' }, content: { text: 'ignore' } },
        { message_id: 'om_visible', chat_id: 'oc_visible', chat_name: 'Visible', chat_type: 'group',
          create_time: String((window.start + 20_000) / 1000), sender: { id: 'ou_visible', name: 'Visible sender' }, content: { text: 'keep' } }
      ], has_more: false } })))
    const outputDirectory = join(root, 'lark-muted-output')
    await mkdir(outputDirectory, { recursive: true })
    await writeFile(join(outputDirectory, 'oc_muted.md'), 'previous muted projection\n')

    await Effect.runPromise(ingestLarkIm({ integrationDirectory, outputDirectory, window }).pipe(Effect.provide(NodeServices.layer)))

    expect(await readdir(outputDirectory)).toEqual(['oc_visible.md'])
    expect(await readFile(join(outputDirectory, 'oc_visible.md'), 'utf8')).toContain('Visible sender')
  })

  it('batches Lark mute lookups and fails closed when any chat status is missing', async () => {
    const integrationDirectory = await prepareLarkIntegration('lark-incomplete-mute')
    const chats = Array.from({ length: 11 }, (_, index) => `oc_${String(index).padStart(2, '0')}`)
    const batchSizes: number[] = []
    mocks.runCli.mockImplementation((_directory, args) => {
      if (args[1] !== 'chat.user_setting') return Effect.succeed(JSON.stringify({ data: { messages: chats.map((chatId, index) => ({
        message_id: `om_${index}`, chat_id: chatId, chat_name: chatId, chat_type: 'group',
        create_time: String((window.start + index * 1000) / 1000), sender: { id: 'ou_sender', name: 'Sender' }, content: { text: 'message' }
      })), has_more: false } }))
      const dataIndex = args.indexOf('--data')
      const requested = JSON.parse(args[dataIndex + 1]!) as { chat_ids: string[] }
      batchSizes.push(requested.chat_ids.length)
      return Effect.succeed(JSON.stringify({ data: { items: requested.chat_ids
        .filter(chatId => chatId !== 'oc_10').map(chatId => ({ chat_id: chatId, is_muted: false })) } }))
    })

    const error = await Effect.runPromise(ingestLarkIm({
      integrationDirectory, outputDirectory: join(root, 'lark-incomplete-output'), window
    }).pipe(Effect.flip, Effect.provide(NodeServices.layer)))

    expect(error).toMatchObject({ _tag: 'IntegrationError', message: 'Lark returned incomplete mute status.' })
    expect(batchSizes.sort((left, right) => left - right)).toEqual([1, 10])
  })

  it('paginates Lark mail summaries and fetches their bodies in one batch', async () => {
    const integrationDirectory = await prepareLarkIntegration('lark-mail')
    const commands: string[][] = []
    mocks.runCli.mockImplementation((_directory, args: readonly string[]) => {
      commands.push([...args])
      if (args[1] === '+triage') {
        const nextPage = args.includes('--page-token')
        return Effect.succeed(JSON.stringify({ ok: true, data: {
          messages: [{ message_id: nextPage ? 'om_mail_2' : 'om_mail_1' }],
          mailbox_id: 'shared@example.com', has_more: !nextPage,
          page_token: nextPage ? '' : 'search:next'
        } }))
      }
      return Effect.succeed(JSON.stringify({ ok: true, data: {
        messages: [
          { message_id: 'om_mail_1', thread_id: 'thread_1', subject: 'First',
            internal_date: String(window.start + 10_000), folder_id: 'INBOX',
            head_from: { name: 'Alice', mail_address: 'alice@example.com' },
            to: [{ name: 'Feng', mail_address: 'feng@example.com' }], body_plain_text: 'First body' },
          { message_id: 'om_mail_2', thread_id: 'thread_2', subject: 'Second',
            internal_date: String(window.start + 20_000), folder_id: 'INBOX',
            head_from: { name: 'Bob', mail_address: 'bob@example.com' },
            to: [{ name: 'Feng', mail_address: 'feng@example.com' }], body_plain_text: 'Second body' }
        ], total: 2
      } }))
    })

    const outputDirectory = join(root, 'lark-mail-output')
    await Effect.runPromise(ingestLarkEmail({ integrationDirectory, outputDirectory, window }).pipe(Effect.provide(NodeServices.layer)))

    expect(await readdir(outputDirectory)).toEqual(['om_mail_1.md', 'om_mail_2.md'])
    expect(await readFile(join(outputDirectory, 'om_mail_1.md'), 'utf8')).toContain('First body')
    const triage = commands.filter(args => args[1] === '+triage')
    expect(triage).toHaveLength(2)
    expect(triage[0]).toEqual(expect.arrayContaining(['--as', 'user', '--max', '400']))
    expect(triage[0]).not.toContain('--page-size')
    expect(JSON.parse(triage[0]![triage[0]!.indexOf('--filter') + 1]!)).toEqual({
      time_range: { start_time: '2026-09-21T00:00:00Z', end_time: '2026-09-21T01:00:00Z' }
    })
    expect(triage[1]).toEqual(expect.arrayContaining(['--page-token', 'search:next']))
    const bodies = commands.filter(args => args[1] === '+messages')
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toEqual(expect.arrayContaining([
      '--as', 'user', '--mailbox', 'shared@example.com', '--message-ids', 'om_mail_1,om_mail_2', '--html=false'
    ]))
  })

  it('fails closed when Lark mail pagination is incomplete', async () => {
    const integrationDirectory = await prepareLarkIntegration('lark-mail-incomplete')
    mocks.runCli.mockReturnValue(Effect.succeed(JSON.stringify({ ok: true, data: {
      messages: [], mailbox_id: 'me', has_more: true, page_token: ''
    } })))

    const error = await Effect.runPromise(ingestLarkEmail({
      integrationDirectory, outputDirectory: join(root, 'lark-mail-incomplete-output'), window
    }).pipe(Effect.flip, Effect.provide(NodeServices.layer)))

    expect(error).toMatchObject({ _tag: 'IntegrationError', message: 'Lark mail pagination was incomplete.' })
  })

  it('fails closed when Lark omits an unaccounted mail body', async () => {
    const integrationDirectory = await prepareLarkIntegration('lark-mail-missing-body')
    mocks.runCli.mockImplementation((_directory, args: readonly string[]) => Effect.succeed(JSON.stringify(args[1] === '+triage'
      ? { ok: true, data: { messages: [{ message_id: 'om_mail_1' }, { message_id: 'om_mail_2' }],
        mailbox_id: 'me', has_more: false, page_token: '' } }
      : { ok: true, data: { messages: [{ message_id: 'om_mail_1', subject: 'First',
        internal_date: String(window.start + 10_000), body_plain_text: 'First body' }],
      total: 1, unavailable_message_ids: [] } })))

    const error = await Effect.runPromise(ingestLarkEmail({
      integrationDirectory, outputDirectory: join(root, 'lark-mail-missing-body-output'), window
    }).pipe(Effect.flip, Effect.provide(NodeServices.layer)))

    expect(error).toMatchObject({ _tag: 'IntegrationError', message: 'Lark returned incomplete mail bodies.' })
  })

  it('accepts Lark mail bodies that are explicitly unavailable', async () => {
    const integrationDirectory = await prepareLarkIntegration('lark-mail-unavailable-body')
    mocks.runCli.mockImplementation((_directory, args: readonly string[]) => Effect.succeed(JSON.stringify(args[1] === '+triage'
      ? { ok: true, data: { messages: [{ message_id: 'om_mail_1' }, { message_id: 'om_mail_unavailable' }],
        mailbox_id: 'me', has_more: false, page_token: '' } }
      : { ok: true, data: { messages: [{ message_id: 'om_mail_1', subject: 'Available',
        internal_date: String(window.start + 10_000), body_plain_text: 'Available body' }],
      total: 1, unavailable_message_ids: ['om_mail_unavailable'] } })))

    const outputDirectory = join(root, 'lark-mail-unavailable-body-output')
    await Effect.runPromise(ingestLarkEmail({ integrationDirectory, outputDirectory, window }).pipe(Effect.provide(NodeServices.layer)))

    expect(await readdir(outputDirectory)).toEqual(['om_mail_1.md'])
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
