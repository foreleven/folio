import { NodeServices } from '@effect/platform-node'
import { Effect, ManagedRuntime } from 'effect'
import { Gaxios } from 'gaxios'
import { OAuth2Client } from 'google-auth-library'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { get as httpGet } from 'node:http'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IntegrationContext } from '../base/index.ts'
import { gmail } from './index.ts'
import { authorizeDesktop, requestDeviceAuthorization } from './oauth.ts'
import { updatePrivateState } from './state.ts'

let root: string | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('Google Gmail integration', () => {
  it('declares a browser action for the Desktop OAuth authorization URL', () => {
    expect(gmail.actions.map((action) => action.id)).toEqual(['open_authorization', 'install', 'open_client_setup', 'connect', 'retry_connect'])
    expect(gmail.actions.find((action) => action.id === 'connect')?.fields?.map((field) => field.id)).toEqual(['clientId', 'clientSecret'])
    expect(gmail.actions.find((action) => action.id === 'open_client_setup')?.description).toMatchObject({
      'zh-CN': expect.stringContaining('console.cloud.google.com/auth/clients')
    })
    expect(gmail.actions.find((action) => action.id === 'connect')?.description).toMatchObject({
      'zh-CN': expect.stringContaining('测试用户')
    })
  })

  it('keeps the legacy device helper free of client secrets', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.example.test:8080')
    vi.stubEnv('HTTP_PROXY', '')
    const request = vi.spyOn(Gaxios.prototype, 'request').mockResolvedValue({
      status: 200,
      data: {
        device_code: 'device',
        user_code: 'ABCD-EFGH',
        verification_url: 'https://www.google.com/device',
        expires_in: 600,
        interval: 1
      }
    } as never)
    const device = await Effect.runPromise(requestDeviceAuthorization('client', 'secret'))
    expect(device.verificationUrl).toBe('https://www.google.com/device?user_code=ABCD-EFGH')
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://oauth2.googleapis.com/device/code',
        method: 'POST',
        responseType: 'json',
        timeout: 30_000,
        data: expect.stringContaining('client_id=client'),
        proxy: 'http://proxy.example.test:8080'
      })
    )
    expect(request.mock.calls[0]?.[0]?.data).not.toContain('client_secret')
  })

  it('exchanges a Desktop OAuth code through a temporary loopback callback', async () => {
    const tokenResponse = {
      tokens: {
        access_token: 'access',
        refresh_token: 'refresh',
        expiry_date: Date.now() + 3_600_000,
        scope: 'https://www.googleapis.com/auth/gmail.readonly'
      },
      res: null
    } as never
    const getToken = vi.spyOn(OAuth2Client.prototype, 'getToken').mockImplementation(() => Promise.resolve(tokenResponse))
    let authorizationUrl = ''
    let authorizationReceived = false
    const result = await Effect.runPromise(
      authorizeDesktop(
        'client.apps.googleusercontent.com',
        'secret',
        (url) =>
          Effect.sync(() => {
            authorizationUrl = url
            const authorization = new URL(url)
            const redirect = new URL(authorization.searchParams.get('redirect_uri')!)
            redirect.searchParams.set('code', 'authorization-code')
            redirect.searchParams.set('state', authorization.searchParams.get('state')!)
            setTimeout(() => {
              const request = httpGet(redirect, (response) => response.resume())
              request.on('error', () => undefined)
            }, 0)
          }),
        () =>
          Effect.sync(() => {
            authorizationReceived = true
          })
      )
    )
    expect(new URL(authorizationUrl).hostname).toBe('accounts.google.com')
    expect(new URL(authorizationUrl).searchParams.get('access_type')).toBe('offline')
    expect(new URL(authorizationUrl).searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/)
    expect(getToken).toHaveBeenCalledWith(expect.objectContaining({ code: 'authorization-code', redirect_uri: expect.stringContaining('127.0.0.1') }))
    expect(authorizationReceived).toBe(true)
    expect(result).toEqual({ accessToken: 'access', refreshToken: 'refresh', expiresAt: expect.any(Number), scope: 'https://www.googleapis.com/auth/gmail.readonly' })
  })

  it('does not wait for Chromium keep-alive sockets after the callback succeeds', async () => {
    const tokenResponse = {
      tokens: {
        access_token: 'access',
        refresh_token: 'refresh',
        expiry_date: Date.now() + 3_600_000
      },
      res: null
    } as never
    vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue(tokenResponse)
    let keepAliveSocket: Socket | undefined
    try {
      const result = await Effect.runPromise(
        authorizeDesktop('client.apps.googleusercontent.com', 'secret', (url) =>
          Effect.sync(() => {
            const authorization = new URL(url)
            const redirect = new URL(authorization.searchParams.get('redirect_uri')!)
            const state = authorization.searchParams.get('state')!
            // Simulate Chromium's preconnected localhost socket. It remains
            // idle while the actual callback request is handled below.
            keepAliveSocket = createConnection({ host: redirect.hostname, port: Number(redirect.port) }, () => {
              setTimeout(() => {
                redirect.searchParams.set('state', state)
                redirect.searchParams.set('code', 'authorization-code')
                const request = httpGet(redirect, (response) => response.resume())
                request.on('error', () => undefined)
              }, 0)
            })
            keepAliveSocket.on('error', () => undefined)
          })
        )
      )
      expect(result.accessToken).toBe('access')
      expect(result.refreshToken).toBe('refresh')
    } finally {
      keepAliveSocket?.destroy()
    }
  })

  it('installs the email resource and mounts only credential-free assets plus an ephemeral token', async () => {
    root = await mkdtemp(join(tmpdir(), 'folio-gmail-test-'))
    const runtime = ManagedRuntime.make(NodeServices.layer)
    const states: string[] = []
    const resources: unknown[] = []
    let callbackError = false
    const context: IntegrationContext['Service'] = {
      directory: root,
      writeState: (state, _data, actions = []) =>
        Effect.sync(() => {
          states.push(state)
          // Complete the local Desktop OAuth redirect just as a browser would.
          // Defer the request until writeState returns and the provider has
          // installed its callback listener.
          if (state === 'waiting_for_user') {
            const action = actions.find((candidate) => candidate.id === 'open_authorization')
            const url = action?.type === 'open-url' ? action.url : undefined
            if (url) {
              const authorization = new URL(url)
              const redirect = new URL(authorization.searchParams.get('redirect_uri')!)
              redirect.searchParams.set('state', authorization.searchParams.get('state')!)
              if (callbackError) redirect.searchParams.set('error', 'access_denied')
              else redirect.searchParams.set('code', 'authorization-code')
              setTimeout(() => {
                const request = httpGet(redirect, (response) => {
                  response.resume()
                  response.on('end', () => undefined)
                })
                request.on('error', () => undefined)
              }, 0)
            }
          }
        }),
      registerResource: (resource) =>
        Effect.sync(() => {
          resources.push({ id: resource.id, type: resource.type, name: resource.name })
        })
    }
    try {
      await runtime.runPromise(gmail.install().pipe(Effect.provideService(IntegrationContext, context)))
      expect(states).toContain('installing')
      expect(resources).toEqual([{ id: 'email', type: 'email', name: { en: 'Gmail email', 'zh-CN': 'Gmail 邮件' } }])
      const inspected = await runtime.runPromise(gmail.inspect().pipe(Effect.provideService(IntegrationContext, context)))
      expect(inspected.state).toBe('login_required')
      expect(inspected.actions).toEqual([
        { id: 'connect', type: 'callback', primary: true },
        { id: 'open_client_setup', type: 'open-url', url: 'https://console.cloud.google.com/auth/clients' }
      ])

      await runtime.runPromise(
        updatePrivateState(root, { oauthClient: { clientId: 'saved-client', clientSecret: 'saved-secret' } }).pipe(Effect.provideService(IntegrationContext, context))
      )
      expect((await runtime.runPromise(gmail.inspect().pipe(Effect.provideService(IntegrationContext, context)))).actions).toEqual([
        { id: 'connect', type: 'callback', primary: true },
        { id: 'retry_connect', type: 'callback' },
        { id: 'open_client_setup', type: 'open-url', url: 'https://console.cloud.google.com/auth/clients' }
      ])

      vi.stubEnv('HTTPS_PROXY', 'http://proxy.example.test:8080')
      vi.stubEnv('HTTP_PROXY', '')
      callbackError = true
      await expect(
        runtime.runPromise(
          gmail.onActionCallback('connect', { clientId: ' saved-client ', clientSecret: ' saved-secret ' }).pipe(Effect.provideService(IntegrationContext, context))
        )
      ).rejects.toThrow('Google authorization failed: access_denied')
      expect(JSON.parse(await readFile(join(root, 'private.json'), 'utf8')).oauthClient).toEqual({
        clientId: 'saved-client',
        clientSecret: 'saved-secret'
      })

      await runtime.runPromise(
        updatePrivateState(root, {
          credentials: { clientId: 'client', clientSecret: 'secret', accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000 }
        }).pipe(Effect.provideService(IntegrationContext, context))
      )
      const mounted = {
        integrationDirectory: root,
        workspaceDirectory: join(root, 'task'),
        instructions: [],
        skills: [],
        executableDirectories: [],
        workspaceFiles: [] as Array<{ path: string; content: string }>,
        env: {} as Record<string, string>
      }
      await runtime.runPromise(gmail.resources[0]!.onIngest(mounted).pipe(Effect.provideService(IntegrationContext, context)))
      expect(mounted.skills).toEqual([join(root, 'skills', 'gmail-mail', 'SKILL.md')])
      expect(mounted.env).toEqual({ GMAIL_ACCESS_TOKEN: 'access' })
      expect(mounted.workspaceFiles.map((file) => file.path)).toEqual(['raws/gmail/_workflow.md', 'raws/gmail/extract-window.mjs'])
      expect(mounted.workspaceFiles.find((file) => file.path === 'raws/gmail/_workflow.md')?.content).toContain('--use-env-proxy')
      expect(await readFile(join(root, 'workflows', 'gmail', 'extract-window.mjs'), 'utf8')).toContain('GMAIL_ACCESS_TOKEN')
    } finally {
      await runtime.dispose()
    }
  })
})
