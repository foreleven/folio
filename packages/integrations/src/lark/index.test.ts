import { NodeServices } from '@effect/platform-node'
import { registerApp } from '@larksuiteoapi/node-sdk'
import { ConfigProvider, Effect, Layer, ManagedRuntime } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lark, LarkApplication } from './index.ts'
import { larkScopes } from './auth.ts'
import { IntegrationContext, IntegrationError } from '../base/index.ts'
import type { IntegrationResource } from '../base/index.ts'
import { skillNames } from './skills.ts'

const sdk = vi.hoisted(() => ({ userInfo: vi.fn(), appToken: vi.fn() }))
vi.mock('@larksuiteoapi/node-sdk', () => ({
  registerApp: vi.fn(), Domain: { Lark: 'lark', Feishu: 'feishu' }, LoggerLevel: { fatal: 0 },
  withUserAccessToken: (token: string) => ({ token }),
  Client: class { request = sdk.appToken; authen = { userInfo: { get: sdk.userInfo } } }
}))
const app = { clientId: 'test-app', clientSecret: 'test-secret', brand: 'feishu' as const }
let root: string
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>

/** Builds the callback protocol used by provider fixtures. */
const callback = (id: string) => ({ id, type: 'callback' as const })

/** Serializes a fake HTTP response; tests never contact Lark or use real credentials. */
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(async () => {
  sdk.userInfo.mockReset().mockResolvedValue({ code: 0, data: { open_id: 'test-user' } })
  sdk.appToken.mockReset().mockResolvedValue({ code: 0, app_access_token: 'test-app-token', tenant_access_token: 'test-tenant-token', expire: 7200 })
  root = await mkdtemp(join(tmpdir(), 'folio-lark-install-test-'))
  vi.mocked(registerApp).mockReset().mockImplementation(async (options) => {
    options.onQRCodeReady({ url: 'https://open.feishu.cn/register', expireIn: 600 })
    options.onStatusChange?.({ status: 'polling', interval: 5 })
    options.onStatusChange?.({ status: 'slow_down', interval: 10 })
    options.onStatusChange?.({ status: 'domain_switched', interval: 10 })
    return { client_id: app.clientId, client_secret: app.clientSecret, user_info: { tenant_brand: app.brand } }
  })
  fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = String(input)
    if (url.endsWith('/device_authorization')) return response({
      device_code: 'test-device', verification_uri: 'https://accounts.feishu.cn/oauth',
      verification_uri_complete: 'https://accounts.feishu.cn/oauth?code=test', expires_in: 30, interval: 1
    })
    if (url.endsWith('/oauth/token')) return response({
      access_token: 'test-user-token', expires_in: 7200, refresh_token: 'test-refresh',
      refresh_token_expires_in: 604800, scope: [...larkScopes, 'offline_access'].join(' ')
    })
    if (url.endsWith('/user_info')) return response({ code: 0, data: { open_id: 'test-user' } })
    throw new Error(`Unexpected request: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(async () => { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }) })

/** Simulates process outcomes but keeps real Effect filesystem operations and private state files. */
function harness(options: { missingCli?: boolean; systemExit?: number; tarExit?: number; gitExit?: number } = {}) {
  const commands: ChildProcess.StandardCommand[] = []
  const states: Array<{ state: string; data: unknown }> = []
  const resources = new Map<string, IntegrationResource>()
  const processLayer = Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
    const actual = yield* ChildProcessSpawner.ChildProcessSpawner
    return ChildProcessSpawner.ChildProcessSpawner.of({ ...actual,
      exitCode: (command) => {
        if (!ChildProcess.isStandardCommand(command)) throw new Error('Expected a direct command')
        commands.push(command)
        if (command.command === 'lark-cli' || command.command.endsWith('/lark-cli')) {
          return options.missingCli && command.command === 'lark-cli'
            ? actual.exitCode(ChildProcess.make(join(root, 'missing-executable')))
            : Effect.succeed(ChildProcessSpawner.ExitCode(options.systemExit ?? 0))
        }
        return Effect.promise(async () => {
          if (command.command === 'git') {
            if (options.gitExit) return ChildProcessSpawner.ExitCode(options.gitExit)
            if (command.args[0] === 'clone') {
              const source = command.args.at(-1)!
              for (const name of skillNames) {
                await mkdir(join(source, 'skills', name, 'references'), { recursive: true })
                await writeFile(join(source, 'skills', name, 'SKILL.md'), 'fixture skill')
                await writeFile(join(source, 'skills', name, 'references', 'details.md'), 'fixture reference')
              }
              await writeFile(join(source, 'LICENSE'), 'fixture license')
            }
          } else if (command.command === '/usr/bin/tar') {
            if (options.tarExit) return ChildProcessSpawner.ExitCode(options.tarExit)
            const prefix = command.args[command.args.indexOf('-C') + 1]
            const binary = join(prefix, 'lark-cli')
            await mkdir(dirname(binary), { recursive: true })
            await writeFile(binary, 'fixture CLI')
          } else await readFile(command.command)
          return ChildProcessSpawner.ExitCode(0)
        })
      }
    })
  })).pipe(Layer.provide(NodeServices.layer))
  const runtime = ManagedRuntime.make(Layer.merge(NodeServices.layer, processLayer).pipe(
    Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ FOLIO_CONFIG_DIR: root })))
  ))
  const directory = join(root, 'integrations', 'lark')
  if (!options.missingCli) { mkdirSync(join(directory, 'cli'), { recursive: true }); writeFileSync(join(directory, 'cli', 'lark-cli'), 'fixture CLI') }
  const context: IntegrationContext["Service"] = {
    directory,
    writeState: (state, data) => Effect.sync(() => { states.push({ state, data }) }),
    registerResource: (resource) => Effect.sync(() => { resources.set(resource.id, resource) })
  }
  return { runtime, commands, states, resources, directory, context }
}

/** Seeds usable private state so reuse and CLI-only paths do not run a device flow. */
async function seed(directory: string, extra = {}) {
  await mkdir(directory, { recursive: true })
  for (const name of skillNames) {
    await mkdir(join(directory, 'skills', name), { recursive: true })
    await writeFile(join(directory, 'skills', name, 'SKILL.md'), 'fixture skill')
  }
  await writeFile(join(directory, 'installed.json'), 'true')
  await writeFile(join(directory, 'app.json'), JSON.stringify(app))
  await writeFile(join(directory, 'app-auth.json'), JSON.stringify({
    clientId: app.clientId, brand: app.brand, appAccessToken: 'test-app-token', expiresAt: Date.now() + 7200000
  }))
  await writeFile(join(directory, 'auth.json'), JSON.stringify({
    clientId: app.clientId, brand: app.brand, accessToken: 'saved-token', expiresAt: Date.now() + 7200000,
    openId: 'test-user', scope: larkScopes.join(' '), ...extra
  }))
}

describe('Lark integration lifecycle', () => {
  it('defines serializable actions and independent empty resource hooks', async () => {
    expect(lark.id).toBe('lark')
    expect(JSON.parse(JSON.stringify(lark.actions)).map((a: { id: string }) => a.id))
      .toEqual(['open_authorization', 'install', 'create_app', 'verify_app', 'refresh_auth', 'authorize'])
    const context = { workspaceDirectory: '/unused', instructions: [], skills: [], env: {} }
    for (const resource of lark.resources) await Effect.runPromise(resource.onIngest(context))
    expect(context).toEqual({ workspaceDirectory: '/unused', instructions: [], skills: [], env: {} })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects an authorization URL outside Lark domains before publishing an external action', async () => {
    const h = harness()
    vi.mocked(registerApp).mockImplementationOnce(async (options) => {
      options.onQRCodeReady({ url: 'https://accounts.feishu.cn.evil.example/authorize', expireIn: 600 })
      return { client_id: app.clientId, client_secret: app.clientSecret }
    })
    try {
      await h.runtime.runPromise(lark.install().pipe(Effect.provideService(IntegrationContext, h.context)))
      await expect(h.runtime.runPromise(lark.onActionCallback('create_app').pipe(Effect.provideService(IntegrationContext, h.context)))).rejects.toThrow()
      expect(h.states.some((entry) => entry.state === 'waiting_for_app')).toBe(false)
      await expect(stat(join(h.directory, 'app.json'))).rejects.toThrow()
      expect((await h.runtime.runPromise(lark.inspect().pipe(Effect.provideService(IntegrationContext, h.context)))).state).toBe('app_required')
    } finally { await h.runtime.dispose() }
  })

  it('inspect is read-only and asks for installation when dependencies are missing', async () => {
    const h = harness({ missingCli: true })
    try {
      expect(await h.runtime.runPromise(lark.inspect().pipe(Effect.provideService(IntegrationContext, h.context))))
        .toEqual({ state: 'install_required', actions: ['install'].map(callback) })
      expect(h.commands).toHaveLength(0)
      expect(h.states).toEqual([])
      expect(registerApp).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
      await expect(stat(h.directory)).rejects.toThrow()
    } finally { await h.runtime.dispose() }
  })

  it('progresses through explicit actions to ready and never automatically starts the next action', async () => {
    const h = harness()
    try {
      await h.runtime.runPromise(lark.onActionCallback('install').pipe(Effect.provideService(IntegrationContext, h.context)))
      expect(h.resources.size).toBe(2)
      expect(h.commands.some((cmd) => cmd.args[0] === 'install')).toBe(false)
      expect(registerApp).not.toHaveBeenCalled()
      expect(h.states.at(-1)?.state).toBe('app_required')
      expect(await readFile(join(h.directory, 'skills/lark-mail/SKILL.md'), 'utf8')).toContain('name: lark-mail')
      await h.runtime.runPromise(lark.onActionCallback('create_app').pipe(Effect.provideService(IntegrationContext, h.context)))
      expect(h.states.map((item) => item.state)).toContain('waiting_for_app')
      expect(h.states.at(-1)?.state).toBe('login_required')
      expect(fetchMock).not.toHaveBeenCalled()
      await h.runtime.runPromise(lark.onActionCallback('authorize').pipe(Effect.provideService(IntegrationContext, h.context)))
      expect(h.states.map((item) => item.state)).toContain('waiting_for_user')
      expect(h.states.at(-1)?.state).toBe('ready')
      expect(await h.runtime.runPromise(lark.inspect().pipe(Effect.provideService(IntegrationContext, h.context)))).toEqual({ state: 'ready', actions: [] })
      expect(JSON.stringify(h.states)).not.toContain('test-secret')
      expect(JSON.stringify(h.states)).not.toContain('test-user-token')
      expect((await stat(join(h.directory, 'auth.json'))).mode & 0o777).toBe(0o600)
      expect((await stat(join(h.directory, 'app.json'))).mode & 0o777).toBe(0o600)
      expect((await stat(h.directory)).mode & 0o777).toBe(0o700)
      expect(vi.mocked(registerApp).mock.calls[0][0].addons?.scopes?.user).toEqual(larkScopes)
      expect(larkScopes.some((scope) => scope.startsWith('mail:'))).toBe(true)
    } finally { await h.runtime.dispose() }
  })

  it('installs missing CLI once, reuses skills, and upserts resources on repeated install', async () => {
    const h = harness({ missingCli: true })
    try {
      await h.runtime.runPromise(lark.install().pipe(Effect.provideService(IntegrationContext, h.context)))
      await h.runtime.runPromise(lark.install().pipe(Effect.provideService(IntegrationContext, h.context)))
      expect(h.commands.filter((cmd) => cmd.command === '/usr/bin/tar')).toHaveLength(1)
      expect(h.commands.filter((cmd) => cmd.args[0] === 'clone')).toHaveLength(0)
      expect([...h.resources.keys()]).toEqual(['im', 'email'])
    } finally { await h.runtime.dispose() }
  })

  it.each([{ missingCli: true, tarExit: 1 }])(
    'preserves a non-ready state when dependency setup fails: %s', async (options) => {
      const h = harness(options)
      try {
        expect(await h.runtime.runPromise(Effect.flip(lark.install().pipe(Effect.provideService(IntegrationContext, h.context))))).toMatchObject({ _tag: 'IntegrationError' })
        expect(h.resources.size).toBe(0)
        expect(registerApp).not.toHaveBeenCalled()
        await expect(stat(join(h.directory, 'installed.json'))).rejects.toThrow()
      } finally { await h.runtime.dispose() }
    }
  )

  it('retries partial resource registration before marking installation complete', async () => {
    const h = harness()
    let fail = true
    const context = { ...h.context, registerResource: (resource: IntegrationResource) =>
      resource.id === 'email' && fail ? Effect.fail(new IntegrationError({ message: 'store failed' }))
        : h.context.registerResource(resource) }
    try {
      await h.runtime.runPromise(Effect.flip(lark.install().pipe(Effect.provideService(IntegrationContext, context))))
      expect((await h.runtime.runPromise(lark.inspect().pipe(Effect.provideService(IntegrationContext, context)))).state).toBe('install_required')
      fail = false
      await h.runtime.runPromise(lark.onActionCallback('install').pipe(Effect.provideService(IntegrationContext, context)))
      expect(h.resources.size).toBe(2)
    } finally { await h.runtime.dispose() }
  })

  it('uses a supplied app and never registers another', async () => {
    const h = harness()
    const context = h.context
    try {
      await h.runtime.runPromise(lark.install().pipe(Effect.provideService(IntegrationContext, context), Effect.provideService(LarkApplication, app)))
      expect((await h.runtime.runPromise(lark.inspect().pipe(Effect.provideService(IntegrationContext, context), Effect.provideService(LarkApplication, app)))).state).toBe('app_authorization_required')
      await h.runtime.runPromise(lark.onActionCallback('verify_app').pipe(Effect.provideService(IntegrationContext, context), Effect.provideService(LarkApplication, app)))
      await h.runtime.runPromise(lark.onActionCallback('authorize').pipe(Effect.provideService(IntegrationContext, context), Effect.provideService(LarkApplication, app)))
      expect(registerApp).not.toHaveBeenCalled()
      expect(h.states.at(-1)?.state).toBe('ready')
    } finally { await h.runtime.dispose() }
  })

  it('rejects unknown and stale callbacks without registration side effects', async () => {
    const h = harness()
    await seed(h.directory)
    try {
      for (const id of ['unknown', 'install', 'create_app', 'authorize']) {
        expect(await h.runtime.runPromise(Effect.flip(lark.onActionCallback(id).pipe(Effect.provideService(IntegrationContext, h.context)))))
          .toMatchObject({ _tag: 'IntegrationError' })
      }
      expect(h.states).toEqual([])
      expect(registerApp).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    } finally { await h.runtime.dispose() }
  })

  it.each([{ expiresAt: 1 }, { scope: 'im:chat:read' }, { clientId: 'another-app' }])(
    'requires authorization for unusable saved tokens: %s', async (extra) => {
      const h = harness()
      await seed(h.directory, extra)
      try {
        expect(await h.runtime.runPromise(lark.inspect().pipe(Effect.provideService(IntegrationContext, h.context))))
          .toEqual({ state: 'login_required', actions: ['authorize'].map(callback) })
        expect(fetchMock).not.toHaveBeenCalled()
        expect(h.states).toEqual([])
      } finally { await h.runtime.dispose() }
    }
  )

  it('preserves the app after OAuth denial and retries only authorization', async () => {
    const h = harness()
    await seed(h.directory, { expiresAt: 1 })
    const normal = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input, init) => String(input).endsWith('/oauth/token')
      ? response({ error: 'access_denied' }, 400) : normal(input, init))
    try {
      const before = await readFile(join(h.directory, 'auth.json'), 'utf8')
      await h.runtime.runPromise(Effect.flip(lark.onActionCallback('authorize').pipe(Effect.provideService(IntegrationContext, h.context))))
      expect(await readFile(join(h.directory, 'auth.json'), 'utf8')).toBe(before)
      expect((await h.runtime.runPromise(lark.inspect().pipe(Effect.provideService(IntegrationContext, h.context)))).state).toBe('login_required')
      fetchMock.mockImplementation(normal)
      await h.runtime.runPromise(lark.onActionCallback('authorize').pipe(Effect.provideService(IntegrationContext, h.context)))
      expect(registerApp).not.toHaveBeenCalled()
      expect(h.states.at(-1)?.state).toBe('ready')
    } finally { await h.runtime.dispose() }
  })

  it('does not mistake SDK/network verification failure for missing credentials', async () => {
    const h = harness()
    await seed(h.directory)
    sdk.userInfo.mockRejectedValue(new Error('secret transport data'))
    try {
      const error = await h.runtime.runPromise(Effect.flip(lark.inspect().pipe(Effect.provideService(IntegrationContext, h.context))))
      expect(error.message).toContain('unavailable')
      expect(JSON.stringify(error)).not.toContain('secret transport data')
      expect(h.states).toEqual([])
      expect(fetchMock).not.toHaveBeenCalled()
    } finally { await h.runtime.dispose() }
  })

  it('waits for authorization state persistence before completing SDK registration', async () => {
    const h = harness()
    await h.runtime.runPromise(lark.install().pipe(Effect.provideService(IntegrationContext, h.context)))
    const context = { ...h.context, writeState: (state: string, data: unknown) => state === 'waiting_for_app'
      ? Effect.fail(new IntegrationError({ message: 'private persistence failure' })) : h.context.writeState(state, data) }
    try {
      const error = await h.runtime.runPromise(Effect.flip(lark.onActionCallback('create_app').pipe(Effect.provideService(IntegrationContext, context))))
      expect(error.message).not.toContain('private persistence failure')
      await expect(stat(join(h.directory, 'app.json'))).rejects.toThrow()
      expect((await h.runtime.runPromise(lark.inspect().pipe(Effect.provideService(IntegrationContext, h.context)))).state).toBe('app_required')
    } finally { await h.runtime.dispose() }
  })

  it('stops at device expiry without polling or overwriting saved auth', async () => {
    const h = harness()
    await seed(h.directory, { expiresAt: 1 })
    fetchMock.mockResolvedValue(response({
      device_code: 'test-device', verification_uri: 'https://accounts.feishu.cn/oauth', expires_in: 0.05, interval: 1
    }))
    try {
      const error = await h.runtime.runPromise(Effect.flip(lark.onActionCallback('authorize').pipe(Effect.provideService(IntegrationContext, h.context))))
      expect(error.message).toContain('expired')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally { await h.runtime.dispose() }
  })

  it('serializes duplicate create callbacks and registers only one application', async () => {
    const h = harness()
    try {
      await h.runtime.runPromise(lark.install().pipe(Effect.provideService(IntegrationContext, h.context)))
      const results = await Promise.allSettled([
        h.runtime.runPromise(lark.onActionCallback('create_app').pipe(Effect.provideService(IntegrationContext, h.context))),
        h.runtime.runPromise(lark.onActionCallback('create_app').pipe(Effect.provideService(IntegrationContext, h.context)))
      ])
      expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
      expect(registerApp).toHaveBeenCalledTimes(1)
    } finally { await h.runtime.dispose() }
  })

  it('cancels pending SDK registration, releases the lock, and permits retry', async () => {
    const h = harness()
    const controller = new AbortController()
    let sdkSignal: AbortSignal | undefined
    vi.mocked(registerApp).mockImplementationOnce((options) => {
      sdkSignal = options.signal
      return new Promise((_, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        options.onQRCodeReady({ url: 'https://open.feishu.cn/register', expireIn: 600 })
      })
    })
    const context = { ...h.context, writeState: (state: string, data: unknown) =>
      h.context.writeState(state, data).pipe(Effect.tap(() => Effect.sync(() => {
        if (state === 'waiting_for_app') controller.abort()
      }))) }
    try {
      await h.runtime.runPromise(lark.install().pipe(Effect.provideService(IntegrationContext, h.context)))
      await expect(h.runtime.runPromise(lark.onActionCallback('create_app').pipe(Effect.provideService(IntegrationContext, context)), { signal: controller.signal }))
        .rejects.toThrow()
      expect(sdkSignal?.aborted).toBe(true)
      expect(h.states.at(-1)?.state).toBe('cancelled')
      expect((await h.runtime.runPromise(lark.inspect().pipe(Effect.provideService(IntegrationContext, h.context)))).state).toBe('app_required')
      await h.runtime.runPromise(lark.onActionCallback('create_app').pipe(Effect.provideService(IntegrationContext, h.context)))
      expect(h.states.at(-1)?.state).toBe('login_required')
    } finally { await h.runtime.dispose() }
  })

  it('keeps polling pending OAuth and checks the resulting user token', async () => {
    const h = harness()
    await seed(h.directory, { expiresAt: 1 })
    const normal = fetchMock.getMockImplementation()!
    let polls = 0
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/oauth/token') && ++polls === 1) {
        return response({ error: 'authorization_pending' }, 400)
      }
      return normal(input, init)
    })
    try {
      await h.runtime.runPromise(lark.onActionCallback('authorize').pipe(Effect.provideService(IntegrationContext, h.context)))
      expect(polls).toBe(2)
      expect(sdk.userInfo).toHaveBeenCalled()
      expect(h.states.at(-1)?.state).toBe('ready')
    } finally { await h.runtime.dispose() }
  })

  it('forwards all registration statuses in order while preserving the authorization URL', async () => {
    const h = harness()
    try {
      await h.runtime.runPromise(lark.install().pipe(Effect.provideService(IntegrationContext, h.context)))
      await h.runtime.runPromise(lark.onActionCallback('create_app').pipe(Effect.provideService(IntegrationContext, h.context)))
      const progress = h.states.filter((item) => item.state === 'waiting_for_app')
      expect(progress.map((item) => item.data)).toEqual([
        expect.objectContaining({ status: 'starting', url: 'https://open.feishu.cn/register' }),
        expect.objectContaining({ status: 'polling', url: 'https://open.feishu.cn/register', interval: 5 }),
        expect.objectContaining({ status: 'slow_down', url: 'https://open.feishu.cn/register', interval: 10 }),
        expect.objectContaining({ status: 'domain_switched', url: 'https://open.feishu.cn/register', interval: 10 })
      ])
      expect(sdk.appToken).toHaveBeenCalledTimes(1)
      expect(JSON.parse(await readFile(join(h.directory, 'app-auth.json'), 'utf8')))
        .toMatchObject({ clientId: app.clientId, appAccessToken: 'test-app-token', tenantAccessToken: 'test-tenant-token' })
      expect(JSON.stringify(h.states)).not.toContain('test-app-token')
    } finally { await h.runtime.dispose() }
  })

  it('returns live inspect state without blocking while the SDK waits for authorization', async () => {
    const h = harness()
    let finish!: () => void
    let notifyReady!: () => void
    const ready = new Promise<void>((resolve) => { notifyReady = resolve })
    vi.mocked(registerApp).mockImplementationOnce((options) => new Promise((resolve) => {
      finish = () => resolve({ client_id: app.clientId, client_secret: app.clientSecret })
      options.onQRCodeReady({ url: 'https://open.feishu.cn/register', expireIn: 600 })
    }))
    const context = { ...h.context, writeState: (state: string, data: unknown) =>
      h.context.writeState(state, data).pipe(Effect.tap(() => Effect.sync(() => {
        if (state === 'waiting_for_app') notifyReady()
      }))) }
    try {
      await h.runtime.runPromise(lark.install().pipe(Effect.provideService(IntegrationContext, h.context)))
      const running = h.runtime.runPromise(lark.onActionCallback('create_app').pipe(Effect.provideService(IntegrationContext, context)))
      await ready
      expect(await h.runtime.runPromise(lark.inspect().pipe(Effect.provideService(IntegrationContext, h.context))))
        .toEqual({ state: 'waiting_for_app', actions: [{ id: 'open_authorization', type: 'open-url', url: 'https://open.feishu.cn/register' }] })
      finish()
      await running
      expect((await h.runtime.runPromise(lark.inspect().pipe(Effect.provideService(IntegrationContext, h.context)))).state).toBe('login_required')
    } finally { finish?.(); await h.runtime.dispose() }
  })

  it('preserves registered app credentials when app-token exchange fails and retries without re-registering', async () => {
    const h = harness()
    sdk.appToken.mockRejectedValueOnce(new Error('sensitive response'))
    try {
      await h.runtime.runPromise(lark.install().pipe(Effect.provideService(IntegrationContext, h.context)))
      await h.runtime.runPromise(Effect.flip(lark.onActionCallback('create_app').pipe(Effect.provideService(IntegrationContext, h.context))))
      expect(h.states.at(-1)?.state).toBe('action_failed')
      expect(await h.runtime.runPromise(lark.inspect().pipe(Effect.provideService(IntegrationContext, h.context))))
        .toEqual({ state: 'app_authorization_required', actions: ['verify_app'].map(callback) })
      expect(JSON.parse(await readFile(join(h.directory, 'app.json'), 'utf8'))).toEqual(app)
      await h.runtime.runPromise(lark.onActionCallback('verify_app').pipe(Effect.provideService(IntegrationContext, h.context)))
      expect(registerApp).toHaveBeenCalledTimes(1)
      expect(h.states.at(-1)?.state).toBe('login_required')
      expect(JSON.stringify(h.states)).not.toContain('sensitive response')
    } finally { await h.runtime.dispose() }
  })

  it('requires renewal of an expired app token before declaring a saved user ready', async () => {
    const h = harness()
    await seed(h.directory)
    await writeFile(join(h.directory, 'app-auth.json'), JSON.stringify({
      clientId: app.clientId, brand: app.brand, appAccessToken: 'old-app-token', expiresAt: 1
    }))
    try {
      expect((await h.runtime.runPromise(lark.inspect().pipe(Effect.provideService(IntegrationContext, h.context)))).state).toBe('app_authorization_required')
      await h.runtime.runPromise(lark.onActionCallback('verify_app').pipe(Effect.provideService(IntegrationContext, h.context)))
      expect((await h.runtime.runPromise(lark.inspect().pipe(Effect.provideService(IntegrationContext, h.context)))).state).toBe('ready')
      expect(fetchMock).not.toHaveBeenCalled()
    } finally { await h.runtime.dispose() }
  })

  it('refreshes user tokens and persists the rotated pair before ready', async () => {
    const h = harness()
    await seed(h.directory, { expiresAt: 1, refreshToken: 'old-refresh', refreshExpiresAt: Date.now() + 3600000 })
    try {
      expect((await h.runtime.runPromise(lark.inspect().pipe(Effect.provideService(IntegrationContext, h.context)))).actions.map((action) => action.id)).toEqual(['refresh_auth', 'authorize'])
      await h.runtime.runPromise(lark.onActionCallback('refresh_auth').pipe(Effect.provideService(IntegrationContext, h.context)))
      const saved = JSON.parse(await readFile(join(h.directory, 'auth.json'), 'utf8'))
      expect(saved).toMatchObject({ accessToken: 'test-user-token', refreshToken: 'test-refresh' })
      expect(new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body)).get('grant_type')).toBe('refresh_token')
      expect(h.states.map((item) => item.state)).not.toContain('waiting_for_user')
      expect(h.states.at(-1)?.state).toBe('ready')
    } finally { await h.runtime.dispose() }
  })

  it('preserves the previous user state after rejected refresh and keeps explicit reauthorization available', async () => {
    const h = harness()
    await seed(h.directory, { expiresAt: 1, refreshToken: 'old-refresh', refreshExpiresAt: Date.now() + 3600000 })
    fetchMock.mockResolvedValue(response({ error: 'invalid_grant' }, 400))
    try {
      const previous = await readFile(join(h.directory, 'auth.json'), 'utf8')
      await h.runtime.runPromise(Effect.flip(lark.onActionCallback('refresh_auth').pipe(Effect.provideService(IntegrationContext, h.context))))
      expect(await readFile(join(h.directory, 'auth.json'), 'utf8')).toBe(previous)
      expect(h.states.at(-1)?.state).toBe('action_failed')
      expect((await h.runtime.runPromise(lark.inspect().pipe(Effect.provideService(IntegrationContext, h.context)))).actions.map((action) => action.id)).toContain('authorize')
    } finally { await h.runtime.dispose() }
  })

  it('honors OAuth slow_down before retrying a pending authorization', async () => {
    const h = harness()
    await seed(h.directory, { expiresAt: 1 })
    const normal = fetchMock.getMockImplementation()!
    const pollTimes: number[] = []
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/oauth/token')) {
        pollTimes.push(Date.now())
        if (pollTimes.length === 1) return response({ error: 'slow_down' }, 400)
      }
      return normal(input, init)
    })
    try {
      await h.runtime.runPromise(lark.onActionCallback('authorize').pipe(Effect.provideService(IntegrationContext, h.context)))
      expect(pollTimes).toHaveLength(2)
      expect(pollTimes[1] - pollTimes[0]).toBeGreaterThanOrEqual(5900)
      expect(h.states.at(-1)?.state).toBe('ready')
    } finally { await h.runtime.dispose() }
  }, 10000)

  it('rejects invalid application token responses without reaching user authorization', async () => {
    const h = harness()
    sdk.appToken.mockResolvedValueOnce({ code: 0, app_access_token: 'test-app-token', expire: 0 })
    try {
      await h.runtime.runPromise(lark.install().pipe(Effect.provideService(IntegrationContext, h.context)))
      await h.runtime.runPromise(Effect.flip(lark.onActionCallback('create_app').pipe(Effect.provideService(IntegrationContext, h.context))))
      expect((await h.runtime.runPromise(lark.inspect().pipe(Effect.provideService(IntegrationContext, h.context)))).state).toBe('app_authorization_required')
      expect(fetchMock).not.toHaveBeenCalled()
      await expect(stat(join(h.directory, 'app-auth.json'))).rejects.toThrow()
    } finally { await h.runtime.dispose() }
  })

  it('retains rotated credentials if verification fails after a successful refresh', async () => {
    const h = harness()
    await seed(h.directory, { expiresAt: 1, refreshToken: 'old-refresh', refreshExpiresAt: Date.now() + 3600000 })
    sdk.userInfo.mockRejectedValueOnce(new Error('temporary network failure'))
    try {
      await h.runtime.runPromise(Effect.flip(lark.onActionCallback('refresh_auth').pipe(Effect.provideService(IntegrationContext, h.context))))
      expect(JSON.parse(await readFile(join(h.directory, 'auth.json'), 'utf8')))
        .toMatchObject({ accessToken: 'test-user-token', refreshToken: 'test-refresh' })
      expect(h.states.at(-1)?.state).toBe('action_failed')
      expect((await h.runtime.runPromise(lark.inspect().pipe(Effect.provideService(IntegrationContext, h.context)))).state).toBe('ready')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally { await h.runtime.dispose() }
  })

  it('never declares ready if a refreshed token resolves to a different user', async () => {
    const h = harness()
    await seed(h.directory, { expiresAt: 1, refreshToken: 'old-refresh', refreshExpiresAt: Date.now() + 3600000 })
    sdk.userInfo.mockResolvedValue({ code: 0, data: { open_id: 'different-user' } })
    try {
      await h.runtime.runPromise(lark.onActionCallback('refresh_auth').pipe(Effect.provideService(IntegrationContext, h.context)))
      expect(h.states.at(-1)?.state).toBe('login_required')
      expect((await h.runtime.runPromise(lark.inspect().pipe(Effect.provideService(IntegrationContext, h.context)))).state).toBe('login_required')
    } finally { await h.runtime.dispose() }
  })

  it('does not overwrite malformed state or leak its contents', async () => {
    const h = harness()
    await seed(h.directory)
    await writeFile(join(h.directory, 'app.json'), '{"clientSecret":"never-log-this"}')
    try {
      const error = await h.runtime.runPromise(Effect.flip(lark.inspect().pipe(Effect.provideService(IntegrationContext, h.context))))
      expect(JSON.stringify(error)).not.toContain('never-log-this')
      expect(await readFile(join(h.directory, 'app.json'), 'utf8')).toContain('never-log-this')
    } finally { await h.runtime.dispose() }
  })
})
