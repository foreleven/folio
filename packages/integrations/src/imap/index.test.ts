import { NodeServices } from '@effect/platform-node'
import { Deferred, Effect, Fiber, ManagedRuntime } from 'effect'
import { ImapFlow } from 'imapflow'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IntegrationContext, type IngestContext } from '../base/index.ts'
import { imap } from './index.ts'
import { parseConnection } from './config.ts'
import { verifyCredentials } from './client.ts'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'folio-imap-')) })
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

describe('IMAP configuration', () => {
  it.each([
    ['person@gmail.com', 'imap.gmail.com'], ['person@qq.com', 'imap.qq.com'], ['person@163.com', 'imap.163.com'],
    ['person@icloud.com', 'imap.mail.me.com']
  ])('recognizes %s without server configuration', async (user, host) => {
    expect(await Effect.runPromise(parseConnection({ user, password: 'abcd efgh ijkl mnop' }))).toMatchObject({
      host, port: 993, security: 'tls', mailbox: 'INBOX', verified: false,
      password: host === 'imap.gmail.com' ? 'abcdefghijklmnop' : 'abcd efgh ijkl mnop'
    })
  })

  it('supports custom domains, usernames, mandatory STARTTLS, folders and proxies', async () => {
    expect(await Effect.runPromise(parseConnection({ user: ' user ', password: ' secret ', host: ' mail.example.test ',
      security: 'starttls', mailbox: 'Archive', proxy: 'socks5://127.0.0.1:1080' }))).toMatchObject({
      user: 'user', password: ' secret ', host: 'mail.example.test', port: 143, security: 'starttls', mailbox: 'Archive'
    })
  })

  it.each([{ host: '' }, { host: 'https://imap.example.test' }, { port: '0' }, { port: '65536' }, { port: '1.5' },
    { port: 'abc' }, { security: 'none' }, { proxy: 'file:///private' }])('rejects invalid connection details %j', async override => {
    await expect(Effect.runPromise(parseConnection({ user: 'user@example.test', password: 'secret', host: 'imap.example.test', ...override }))).rejects.toThrow()
  })
})

describe('IMAP integration lifecycle', () => {
  it('installs, retries saved credentials, mounts safe assets, and disconnects', async () => {
    const runtime = ManagedRuntime.make(NodeServices.layer)
    const published: unknown[] = []
    const context: IntegrationContext['Service'] = {
      directory: root, writeState: (state, data, actions) => Effect.sync(() => { published.push({ state, data, actions }) }),
      registerResource: resource => Effect.sync(() => { published.push(resource) })
    }
    const connect = vi.spyOn(ImapFlow.prototype, 'connect').mockRejectedValueOnce(new Error('secret from server'))
      .mockResolvedValue(undefined)
    const open = vi.spyOn(ImapFlow.prototype, 'mailboxOpen').mockResolvedValue({ path: 'INBOX' } as never)
    vi.spyOn(ImapFlow.prototype, 'logout').mockResolvedValue(undefined)
    const close = vi.spyOn(ImapFlow.prototype, 'close').mockImplementation(() => {})
    const provide = <A, E>(effect: Effect.Effect<A, E, IntegrationContext | NodeServices.NodeServices>) =>
      runtime.runPromise(effect.pipe(Effect.provideService(IntegrationContext, context)))
    try {
      expect((await provide(imap.inspect())).state).toBe('install_required')
      await provide(imap.install())
      expect((await provide(imap.inspect())).state).toBe('login_required')
      await expect(provide(imap.onActionCallback('connect', { user: 'person@gmail.com', password: 'secret' }))).rejects.toThrow('Could not connect')
      expect((await provide(imap.inspect())).state).toBe('recovering')
      expect(close).toHaveBeenCalledTimes(1)
      expect((await stat(join(root, 'private.json'))).mode & 0o777).toBe(0o600)
      expect(JSON.parse(await readFile(join(root, 'private.json'), 'utf8')).credentials.verified).toBe(false)
      await provide(imap.onActionCallback('retry_check'))
      expect((await provide(imap.inspect())).state).toBe('ready')
      expect(open).toHaveBeenCalledWith('INBOX', { readOnly: true })
      expect(connect).toHaveBeenCalledTimes(2)
      const mounted: IngestContext = { integrationDirectory: root, workspaceDirectory: join(root, 'task'),
        instructions: [], skills: [], executableDirectories: [], workspaceFiles: [], env: {} }
      await Effect.runPromise(imap.resources[0]!.onIngest(mounted))
      expect(mounted.workspaceFiles?.map(file => file.path)).toEqual(['raws/imap/_workflow.md', 'raws/imap/extract-window.mjs'])
      expect(JSON.stringify(mounted.workspaceFiles)).not.toContain('secret')
      expect(JSON.stringify(published)).not.toContain('secret')
      expect(JSON.parse(mounted.env.IMAP_CONNECTION).password).toBe('secret')
      expect(mounted.env.IMAPFLOW_MODULE_PATH).toContain('imapflow')
      expect(mounted.env.IMAP_HTML_TO_TEXT_MODULE_PATH).toContain('html-to-text')
      expect(mounted.env.IMAP_MAILPARSER_MODULE_PATH).toContain('mailparser')
      await provide(imap.setup!())
      expect((await provide(imap.inspect())).state).toBe('ready')
      connect.mockRejectedValueOnce(new Error('temporary'))
      await expect(provide(imap.check())).rejects.toThrow('Could not connect')
      expect((await provide(imap.inspect())).state).toBe('recovering')
      await provide(imap.onActionCallback('retry_check'))
      await provide(imap.onActionCallback('disconnect'))
      expect((await provide(imap.inspect())).state).toBe('login_required')
      expect(await readFile(join(root, 'private.json'), 'utf8')).not.toContain('secret')
      await expect(Effect.runPromise(imap.resources[0]!.onIngest(mounted))).rejects.toThrow('Connect and verify')
    } finally { await runtime.dispose() }
  })

  it('closes the connection when verification is interrupted', async () => {
    const close = vi.spyOn(ImapFlow.prototype, 'close').mockImplementation(() => {})
    await Effect.runPromise(Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      vi.spyOn(ImapFlow.prototype, 'connect').mockImplementation(() => {
        Deferred.doneUnsafe(started, Effect.succeed(undefined))
        return new Promise(() => {})
      })
      const credentials = yield* parseConnection({ user: 'person@gmail.com', password: 'secret' })
      const fiber = yield* verifyCredentials(credentials).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      expect(close).toHaveBeenCalledTimes(1)
    }))
  })
})
