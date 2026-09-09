import { NodeServices } from '@effect/platform-node'
import { registerApp } from '@larksuiteoapi/node-sdk'
import { ConfigProvider, Effect, Exit, Layer, Logger, ManagedRuntime, References, Scope } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lark, LarkApplication } from './index.ts'
import { TestClock } from 'effect/testing'
import { releaseSession } from './connection.ts'
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
const callback = (id: string) => ({ id, type: 'callback' as const, primary: true })

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
  const controller = new AbortController()
  let background: Promise<void> | undefined
  /** Starts the real provider lifetime; tests observe committed states rather than calling private renewal helpers. */
  const start = () => { background ??= runtime.runPromise(lark.run!().pipe(Effect.provideService(IntegrationContext, context)), { signal: controller.signal }).catch(() => undefined) }
  const stop = async () => { controller.abort(); await background; await runtime.runPromise(releaseSession.pipe(Effect.provideService(IntegrationContext, context))) }
  const checked = () => runtime.runPromise(lark.inspect().pipe(Effect.provideService(IntegrationContext, context)))
  const settled = (state: string) => vi.waitFor(() => expect(states.at(-1)?.state).toBe(state))
  return { runtime, commands, states, resources, directory, context, start, stop, checked, settled }
}

/** Captures Debug-and-above Effect logs for one harness without changing its provider dependencies. */
function logCollector(h: ReturnType<typeof harness>) {
  const lines: string[] = []
  const logger = Logger.formatJson.pipe(Logger.map((line) => { lines.push(line) }))
  const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) => h.runtime.runPromise(
    effect.pipe(
      Effect.provide(Logger.layer([logger])),
      Effect.provideService(References.MinimumLogLevel, 'Debug')
    )
  )
  return { lines, run }
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
      .toEqual(['open_authorization', 'install', 'connect'])
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
      await expect(h.runtime.runPromise(lark.onActionCallback('connect').pipe(Effect.provideService(IntegrationContext, h.context)))).rejects.toThrow()
      expect(h.states.some((entry) => entry.state === 'waiting_for_app')).toBe(false)
      await expect(stat(join(h.directory, 'app.json'))).rejects.toThrow()
      expect((await h.runtime.runPromise(lark.inspect().pipe(Effect.provideService(IntegrationContext, h.context)))).state).toBe('app_required')
    } finally { await h.stop(); await h.runtime.dispose() }
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
    } finally { await h.stop(); await h.runtime.dispose() }
  })

  it('installs explicitly, then connects through both approvals with one action', async () => {
    const h = harness()
    try {
      await h.runtime.runPromise(lark.install().pipe(Effect.provideService(IntegrationContext, h.context)))
      expect(h.resources.size).toBe(2)
      expect(registerApp).not.toHaveBeenCalled()
      expect((await h.checked()).state).toBe('app_required')
      expect(await readFile(join(h.directory, 'skills/lark-mail/SKILL.md'), 'utf8')).toContain('name: lark-mail')
      await h.runtime.runPromise(lark.onActionCallback('connect').pipe(Effect.provideService(IntegrationContext, h.context)))
      expect(h.states.map((item) => item.state)).toEqual(expect.arrayContaining(['waiting_for_app', 'waiting_for_user', 'ready']))
      expect(await h.checked()).toEqual({ state: 'ready', actions: [] })
      for (const secret of ['test-secret', 'test-user-token', 'test-refresh']) expect(JSON.stringify(h.states)).not.toContain(secret)
      for (const file of ['auth.json', 'app.json']) expect((await stat(join(h.directory, file))).mode & 0o777).toBe(0o600)
      expect((await stat(h.directory)).mode & 0o777).toBe(0o700)
      expect(vi.mocked(registerApp).mock.calls[0][0].addons?.scopes?.user).toEqual(larkScopes)
    } finally { await h.stop(); await h.runtime.dispose() }
  })

  it('logs lifecycle stages without exposing Lark credentials or identity', async () => {
    const h = harness()
    const logs = logCollector(h)
    try {
      await logs.run(lark.install().pipe(Effect.provideService(IntegrationContext, h.context)))
      await logs.run(lark.onActionCallback('connect').pipe(Effect.provideService(IntegrationContext, h.context)))
      const output = logs.lines.join('\n')
      for (const message of [
        'Lark installation started', 'Lark CLI ready', 'Lark skills ready',
        'Reusing installed Lark CLI', 'Lark skills installation completed',
        'Lark application registration started', 'Lark application authorization completed',
        'Lark registration SDK started', 'Lark registration SDK completed',
        'Lark user authorization started', 'Lark user authorization completed', 'Lark connection completed'
      ]) expect(output).toContain(message)
      for (const secret of [root, 'https://', 'test-app', 'test-secret', 'test-app-token', 'test-user-token',
        'test-refresh', 'test-user', 'test-device']) {
        expect(output).not.toContain(secret)
      }
    } finally { await h.stop(); await h.runtime.dispose() }
  })

  it('logs dependency setup failures without exposing private installation details', async () => {
    const h = harness({ missingCli: true, tarExit: 1 })
    const logs = logCollector(h)
    try {
      await logs.run(Effect.flip(lark.install().pipe(Effect.provideService(IntegrationContext, h.context))))
      const output = logs.lines.join('\n')
      for (const message of ['Lark CLI installation started', 'Lark CLI installation failed',
        'Lark installation failed']) expect(output).toContain(message)
      expect(output).not.toContain(root)
      expect(output).not.toContain('lark-cli-1.0.94-darwin-arm64.tar.gz')
    } finally { await h.stop(); await h.runtime.dispose() }
  })

  it('installs missing CLI once, reuses skills, and upserts resources on repeated install', async () => {
    const h = harness({ missingCli: true })
    try {
      await h.runtime.runPromise(lark.install().pipe(Effect.provideService(IntegrationContext, h.context)))
      await h.runtime.runPromise(lark.install().pipe(Effect.provideService(IntegrationContext, h.context)))
      expect(h.commands.filter((cmd) => cmd.command === '/usr/bin/tar')).toHaveLength(1)
      expect(h.commands.filter((cmd) => cmd.args[0] === 'clone')).toHaveLength(0)
      expect([...h.resources.keys()]).toEqual(['im', 'email'])
    } finally { await h.stop(); await h.runtime.dispose() }
  })

  it.each([{ missingCli: true, tarExit: 1 }])(
    'preserves a non-ready state when dependency setup fails: %s', async (options) => {
      const h = harness(options)
      try {
        expect(await h.runtime.runPromise(Effect.flip(lark.install().pipe(Effect.provideService(IntegrationContext, h.context))))).toMatchObject({ _tag: 'IntegrationError' })
        expect(h.resources.size).toBe(0)
        expect(registerApp).not.toHaveBeenCalled()
        await expect(stat(join(h.directory, 'installed.json'))).rejects.toThrow()
      } finally { await h.stop(); await h.runtime.dispose() }
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
    } finally { await h.stop(); await h.runtime.dispose() }
  })

  it('verifies a supplied app internally and only asks for user authorization', async () => {
    const h = harness()
    try {
      await h.runtime.runPromise(lark.install().pipe(Effect.provideService(IntegrationContext, h.context), Effect.provideService(LarkApplication, app)))
      const checked = await h.runtime.runPromise(lark.inspect().pipe(Effect.provideService(IntegrationContext, h.context), Effect.provideService(LarkApplication, app)))
      expect(checked).toEqual({ state: 'login_required', actions: [callback('connect')] })
      await h.runtime.runPromise(lark.onActionCallback('connect').pipe(Effect.provideService(IntegrationContext, h.context), Effect.provideService(LarkApplication, app)))
      expect(registerApp).not.toHaveBeenCalled()
      expect(h.states.at(-1)?.state).toBe('ready')
    } finally { await h.stop(); await h.runtime.dispose() }
  })

  it('rejects unknown and stale callbacks without registration side effects', async () => {
    const h = harness()
    await seed(h.directory)
    try {
      for (const id of ['unknown', 'install', 'connect', 'connect']) {
        expect(await h.runtime.runPromise(Effect.flip(lark.onActionCallback(id).pipe(Effect.provideService(IntegrationContext, h.context)))))
          .toMatchObject({ _tag: 'IntegrationError' })
      }
      expect(h.states).toEqual([])
      expect(registerApp).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    } finally { await h.stop(); await h.runtime.dispose() }
  })

  it.each([{ expiresAt: 1 }, { scope: 'im:chat:read' }, { clientId: 'another-app' }])(
    'requires authorization for unusable saved tokens: %s', async (extra) => {
      const h = harness()
      await seed(h.directory, extra)
      try {
        expect(await h.runtime.runPromise(lark.inspect().pipe(Effect.provideService(IntegrationContext, h.context))))
          .toEqual({ state: 'login_required', actions: ['connect'].map(callback) })
        expect(fetchMock).not.toHaveBeenCalled()
        expect(h.states).toEqual([])
      } finally { await h.stop(); await h.runtime.dispose() }
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
      await h.runtime.runPromise(Effect.flip(lark.onActionCallback('connect').pipe(Effect.provideService(IntegrationContext, h.context))))
      expect(await readFile(join(h.directory, 'auth.json'), 'utf8')).toBe(before)
      expect((await h.runtime.runPromise(lark.inspect().pipe(Effect.provideService(IntegrationContext, h.context)))).state).toBe('login_required')
      fetchMock.mockImplementation(normal)
      await h.runtime.runPromise(lark.onActionCallback('connect').pipe(Effect.provideService(IntegrationContext, h.context)))
      expect(registerApp).not.toHaveBeenCalled()
      expect(h.states.at(-1)?.state).toBe('ready')
    } finally { await h.stop(); await h.runtime.dispose() }
  })

  it('keeps a valid connection usable during temporary verification failure', async () => {
    const h = harness()
    await seed(h.directory)
    sdk.userInfo.mockRejectedValue(new Error('secret transport data'))
    try {
      h.start()
      await h.settled('ready')
      expect(await h.checked()).toEqual({ state: 'ready', actions: [] })
      expect(JSON.stringify(h.states)).not.toContain('secret transport data')
      expect(fetchMock).not.toHaveBeenCalled()
    } finally { await h.stop(); await h.runtime.dispose() }
  })

  it('waits for authorization state persistence before completing SDK registration', async () => {
    const h = harness()
    await h.runtime.runPromise(lark.install().pipe(Effect.provideService(IntegrationContext, h.context)))
    const context = { ...h.context, writeState: (state: string, data: unknown) => state === 'waiting_for_app'
      ? Effect.fail(new IntegrationError({ message: 'private persistence failure' })) : h.context.writeState(state, data) }
    try {
      const error = await h.runtime.runPromise(Effect.flip(lark.onActionCallback('connect').pipe(Effect.provideService(IntegrationContext, context))))
      expect(error.message).not.toContain('private persistence failure')
      await expect(stat(join(h.directory, 'app.json'))).rejects.toThrow()
      expect((await h.runtime.runPromise(lark.inspect().pipe(Effect.provideService(IntegrationContext, h.context)))).state).toBe('app_required')
    } finally { await h.stop(); await h.runtime.dispose() }
  })

  it('stops at device expiry without polling or overwriting saved auth', async () => {
    const h = harness()
    await seed(h.directory, { expiresAt: 1 })
    fetchMock.mockResolvedValue(response({
      device_code: 'test-device', verification_uri: 'https://accounts.feishu.cn/oauth', expires_in: 0.05, interval: 1
    }))
    try {
      const error = await h.runtime.runPromise(Effect.flip(lark.onActionCallback('connect').pipe(Effect.provideService(IntegrationContext, h.context))))
      expect(error.message).toContain('expired')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally { await h.stop(); await h.runtime.dispose() }
  })

  it('serializes duplicate create callbacks and registers only one application', async () => {
    const h = harness()
    try {
      await h.runtime.runPromise(lark.install().pipe(Effect.provideService(IntegrationContext, h.context)))
      const results = await Promise.allSettled([
        h.runtime.runPromise(lark.onActionCallback('connect').pipe(Effect.provideService(IntegrationContext, h.context))),
        h.runtime.runPromise(lark.onActionCallback('connect').pipe(Effect.provideService(IntegrationContext, h.context)))
      ])
      expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
      expect(registerApp).toHaveBeenCalledTimes(1)
    } finally { await h.stop(); await h.runtime.dispose() }
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
      await expect(h.runtime.runPromise(lark.onActionCallback('connect').pipe(Effect.provideService(IntegrationContext, context)), { signal: controller.signal }))
        .rejects.toThrow()
      expect(sdkSignal?.aborted).toBe(true)
      expect(h.states.at(-1)?.state).toBe('cancelled')
      expect((await h.runtime.runPromise(lark.inspect().pipe(Effect.provideService(IntegrationContext, h.context)))).state).toBe('app_required')
      await h.runtime.runPromise(lark.onActionCallback('connect').pipe(Effect.provideService(IntegrationContext, h.context)))
      expect(h.states.at(-1)?.state).toBe('ready')
    } finally { await h.stop(); await h.runtime.dispose() }
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
      await h.runtime.runPromise(lark.onActionCallback('connect').pipe(Effect.provideService(IntegrationContext, h.context)))
      expect(polls).toBe(2)
      expect(sdk.userInfo).toHaveBeenCalled()
      expect(h.states.at(-1)?.state).toBe('ready')
    } finally { await h.stop(); await h.runtime.dispose() }
  })

  it('publishes registration progress without leaking SDK details or credentials', async () => {
    const h = harness()
    try {
      await h.runtime.runPromise(lark.install().pipe(Effect.provideService(IntegrationContext, h.context)))
      await h.runtime.runPromise(lark.onActionCallback('connect').pipe(Effect.provideService(IntegrationContext, h.context)))
      expect(h.states.filter((item) => item.state === 'waiting_for_app')).toHaveLength(4)
      expect(h.states.every((item) => JSON.stringify(item.data) === '{}')).toBe(true)
      expect(sdk.appToken).toHaveBeenCalledTimes(1)
      expect(JSON.parse(await readFile(join(h.directory, 'app-auth.json'), 'utf8'))).toMatchObject({ clientId: app.clientId, appAccessToken: 'test-app-token' })
      expect(JSON.stringify(h.states)).not.toContain('test-app-token')
    } finally { await h.stop(); await h.runtime.dispose() }
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
      const running = h.runtime.runPromise(lark.onActionCallback('connect').pipe(Effect.provideService(IntegrationContext, context)))
      await ready
      expect(await h.runtime.runPromise(lark.inspect().pipe(Effect.provideService(IntegrationContext, h.context))))
        .toEqual({ state: 'waiting_for_app', actions: [{ id: 'open_authorization', type: 'open-url', url: 'https://open.feishu.cn/register', primary: true }] })
      finish()
      await running
      expect((await h.runtime.runPromise(lark.inspect().pipe(Effect.provideService(IntegrationContext, h.context)))).state).toBe('ready')
    } finally { finish?.(); await h.stop(); await h.runtime.dispose() }
  })

  it('preserves a registered app after transient exchange failure and recovers in the background', async () => {
    const h = harness()
    sdk.appToken.mockRejectedValueOnce(new Error('sensitive response'))
    try {
      await h.runtime.runPromise(lark.install().pipe(Effect.provideService(IntegrationContext, h.context)))
      await expect(h.runtime.runPromise(lark.onActionCallback('connect').pipe(Effect.provideService(IntegrationContext, h.context)))).rejects.toThrow()
      expect(await h.checked()).toEqual({ state: 'recovering', actions: [] })
      expect(JSON.parse(await readFile(join(h.directory, 'app.json'), 'utf8'))).toEqual(app)
      h.start()
      await h.settled('login_required')
      await h.runtime.runPromise(lark.onActionCallback('connect').pipe(Effect.provideService(IntegrationContext, h.context)))
      expect(registerApp).toHaveBeenCalledTimes(1)
      expect((await h.checked()).state).toBe('ready')
      expect(JSON.stringify(h.states)).not.toContain('sensitive response')
    } finally { await h.stop(); await h.runtime.dispose() }
  })

  it('automatically renews an expired app token before publishing ready', async () => {
    const h = harness()
    await seed(h.directory)
    await writeFile(join(h.directory, 'app-auth.json'), JSON.stringify({ clientId: app.clientId, brand: app.brand, appAccessToken: 'old-app-token', expiresAt: 1 }))
    try {
      expect(await h.checked()).toEqual({ state: 'recovering', actions: [] })
      h.start()
      await h.settled('ready')
      expect(sdk.appToken).toHaveBeenCalledTimes(1)
      expect(fetchMock).not.toHaveBeenCalled()
    } finally { await h.stop(); await h.runtime.dispose() }
  })

  it('automatically refreshes user tokens and persists the verified rotated pair before ready', async () => {
    const h = harness()
    await seed(h.directory, { expiresAt: 1, refreshToken: 'old-refresh', refreshExpiresAt: Date.now() + 3600000 })
    try {
      expect(await h.checked()).toEqual({ state: 'recovering', actions: [] })
      h.start()
      await h.settled('ready')
      expect(JSON.parse(await readFile(join(h.directory, 'auth.json'), 'utf8'))).toMatchObject({ accessToken: 'test-user-token', refreshToken: 'test-refresh', verified: true })
      expect(new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body)).get('grant_type')).toBe('refresh_token')
      expect(h.states.some((item) => item.state === 'waiting_for_user')).toBe(false)
    } finally { await h.stop(); await h.runtime.dispose() }
  })

  it('offers user intervention after permanent refresh rejection without destroying credentials', async () => {
    const h = harness()
    await seed(h.directory, { expiresAt: 1, refreshToken: 'old-refresh', refreshExpiresAt: Date.now() + 3600000 })
    fetchMock.mockResolvedValue(response({ error: 'invalid_grant' }, 400))
    try {
      const previous = await readFile(join(h.directory, 'auth.json'), 'utf8')
      h.start()
      await h.settled('login_required')
      expect(await readFile(join(h.directory, 'auth.json'), 'utf8')).toBe(previous)
      expect(await h.checked()).toEqual({ state: 'login_required', actions: [callback('connect')] })
    } finally { await h.stop(); await h.runtime.dispose() }
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
      await h.runtime.runPromise(lark.onActionCallback('connect').pipe(Effect.provideService(IntegrationContext, h.context)))
      expect(pollTimes).toHaveLength(2)
      expect(pollTimes[1] - pollTimes[0]).toBeGreaterThanOrEqual(5900)
      expect(h.states.at(-1)?.state).toBe('ready')
    } finally { await h.stop(); await h.runtime.dispose() }
  }, 10000)

  it('rejects invalid application token responses without reaching user authorization', async () => {
    const h = harness()
    sdk.appToken.mockResolvedValueOnce({ code: 0, app_access_token: 'test-app-token', expire: 0 })
    try {
      await h.runtime.runPromise(lark.install().pipe(Effect.provideService(IntegrationContext, h.context)))
      await h.runtime.runPromise(Effect.flip(lark.onActionCallback('connect').pipe(Effect.provideService(IntegrationContext, h.context))))
      expect((await h.runtime.runPromise(lark.inspect().pipe(Effect.provideService(IntegrationContext, h.context)))).state).toBe('recovering')
      expect(fetchMock).not.toHaveBeenCalled()
      await expect(stat(join(h.directory, 'app-auth.json'))).rejects.toThrow()
    } finally { await h.stop(); await h.runtime.dispose() }
  })

  it('retains unverified rotated credentials after a network failure and verifies them after restart', async () => {
    const h = harness()
    await seed(h.directory, { expiresAt: 1, refreshToken: 'old-refresh', refreshExpiresAt: Date.now() + 3600000 })
    sdk.userInfo.mockRejectedValueOnce(new Error('temporary network failure'))
    try {
      h.start()
      await h.settled('recovering')
      expect(JSON.parse(await readFile(join(h.directory, 'auth.json'), 'utf8'))).toMatchObject({ accessToken: 'test-user-token', refreshToken: 'test-refresh', verified: false })
      expect((await h.checked()).state).toBe('recovering')
      await h.stop()
      const next = harness()
      try {
        next.start()
        await next.settled('ready')
        expect(fetchMock).toHaveBeenCalledTimes(1)
      } finally { await next.stop(); await next.runtime.dispose() }
    } finally { await h.stop(); await h.runtime.dispose() }
  })

  it('never declares ready if a refreshed token resolves to a different user', async () => {
    const h = harness()
    await seed(h.directory, { expiresAt: 1, refreshToken: 'old-refresh', refreshExpiresAt: Date.now() + 3600000 })
    sdk.userInfo.mockResolvedValue({ code: 0, data: { open_id: 'different-user' } })
    try {
      h.start()
      await h.settled('login_required')
      expect(h.states.some((item) => item.state === 'ready')).toBe(false)
      expect(JSON.parse(await readFile(join(h.directory, 'auth.json'), 'utf8')).verified).toBe(false)
    } finally { await h.stop(); await h.runtime.dispose() }
  })

  it('does not overwrite malformed state or leak its contents', async () => {
    const h = harness()
    await seed(h.directory)
    await writeFile(join(h.directory, 'app.json'), '{"clientSecret":"never-log-this"}')
    try {
      const error = await h.runtime.runPromise(Effect.flip(lark.inspect().pipe(Effect.provideService(IntegrationContext, h.context))))
      expect(JSON.stringify(error)).not.toContain('never-log-this')
      expect(await readFile(join(h.directory, 'app.json'), 'utf8')).toContain('never-log-this')
    } finally { await h.stop(); await h.runtime.dispose() }
  })
  it('retries transient refresh failures across expiry, then recovers without asking for OAuth', async () => {
    const h = harness()
    const now = Date.now()
    await seed(h.directory, { expiresAt: now + 50_000, refreshToken: 'old-refresh', refreshExpiresAt: now + 3_600_000 })
    const normal = fetchMock.getMockImplementation()!
    fetchMock.mockRejectedValue(new Error('temporary network failure'))
    try {
      await h.runtime.runPromise(Effect.gen(function*() {
        yield* TestClock.setTime(now)
        yield* lark.run!().pipe(Effect.provideService(IntegrationContext, h.context), Effect.forkScoped)
        yield* Effect.promise(() => h.settled('ready'))
        yield* TestClock.adjust(50_000)
        yield* Effect.promise(() => h.settled('recovering'))
        expect(h.states.some((item) => item.state === 'login_required')).toBe(false)
        fetchMock.mockImplementation(normal)
        yield* TestClock.adjust(120_000)
        yield* Effect.promise(() => h.settled('ready'))
        expect(h.states.some((item) => item.state === 'waiting_for_user')).toBe(false)
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())))
    } finally { await h.stop(); await h.runtime.dispose() }
  })

  it('renews at its own expiry deadline and cancels scheduled work when the host closes', async () => {
    const h = harness()
    const now = Date.now()
    await seed(h.directory, { expiresAt: now + 120_000, refreshToken: 'old-refresh', refreshExpiresAt: now + 3_600_000 })
    try {
      await h.runtime.runPromise(Effect.gen(function*() {
        yield* TestClock.setTime(now)
        const scope = yield* Scope.make()
        yield* lark.run!().pipe(Effect.provideService(IntegrationContext, h.context), Effect.forkIn(scope))
        try {
          yield* Effect.promise(() => h.settled('ready'))
          expect(fetchMock).not.toHaveBeenCalled()
          yield* TestClock.adjust(60_000)
          yield* Effect.promise(() => vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1)))
        } finally {
          yield* Scope.close(scope, Exit.void)
        }
        const calls = fetchMock.mock.calls.length
        const writes = h.states.length
        yield* TestClock.adjust('3 hours')
        expect(fetchMock).toHaveBeenCalledTimes(calls)
        expect(h.states).toHaveLength(writes)
      }).pipe(Effect.provide(TestClock.layer())))
    } finally { await h.stop(); await h.runtime.dispose() }
  })

})
