import { Effect, Schema } from 'effect'
import { defineIntegration, IntegrationContext, IntegrationError } from '../base/index.ts'
import type { CheckResult, IntegrationAction } from '../base/index.ts'
import { gmailMetadata } from './metadata.ts'
import { GmailCredentials, GmailOAuthClient, readPrivateState, updatePrivateState } from './state.ts'
import { authorizeDesktop, gmailScope, hasGmailScope, maintainCredentials, verifyCredentials } from './oauth.ts'
import { ingestGmail } from './ingest.ts'
// Google documents the client-specific page for Desktop OAuth clients.
const clientSetupUrl = 'https://console.cloud.google.com/auth/clients'
const consentSetupUrl = 'https://console.cloud.google.com/apis/credentials/consent'
const gmailApiSetupUrl = 'https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com'

const resources = [
  {
    id: 'email',
    type: 'email' as const,
    name: { en: 'Gmail email', 'zh-CN': 'Gmail 邮件' },
    onIngest: () => Effect.void,
    ingest: ingestGmail
  }
] as const

const actions = [
  { id: 'open_authorization', label: { en: 'Continue in Google', 'zh-CN': '前往 Google 授权' } },
  { id: 'install', label: { en: 'Install', 'zh-CN': '安装' } },
  {
    id: 'open_client_setup',
    label: { en: 'Create OAuth client', 'zh-CN': '创建 OAuth 客户端' },
    description: {
      en: `In Google Cloud, enable the Gmail API (${gmailApiSetupUrl}), configure the OAuth consent screen as External/Testing (${consentSetupUrl}), add your account under Test users (publishing is not required), then create a Desktop app client: ${clientSetupUrl}`,
      'zh-CN': `在 Google Cloud 启用 Gmail API（${gmailApiSetupUrl}），将 OAuth 同意屏幕设为“外部/测试中”（${consentSetupUrl}），在“测试用户”中添加你的账号（不需要发布），再创建“桌面应用”客户端：${clientSetupUrl}`
    }
  },
  {
    id: 'connect',
    label: { en: 'Connect Gmail', 'zh-CN': '连接 Gmail' },
    description: {
      en: `Google requires a project-owned OAuth client. Enable Gmail API, configure an External/Testing consent screen, add yourself as a Test user (do not publish), create a Desktop app client, then enter its ID and secret. Consent screen: ${consentSetupUrl}. Client setup: ${clientSetupUrl}.`,
      'zh-CN': `Google 要求使用项目自己的 OAuth 客户端。请启用 Gmail API，将同意屏幕设为“外部/测试中”并把自己添加为“测试用户”（无需发布），创建“桌面应用”客户端，然后填写 ID 和密钥。同意屏幕：${consentSetupUrl}；客户端创建：${clientSetupUrl}。`
    },
    fields: [
      {
        id: 'clientId',
        label: { en: 'OAuth client ID', 'zh-CN': 'OAuth 客户端 ID' },
        type: 'text' as const,
        required: true,
        description: { en: 'Copy the ID ending in .apps.googleusercontent.com from Google Cloud.', 'zh-CN': '从 Google Cloud 复制以 .apps.googleusercontent.com 结尾的客户端 ID。' }
      },
      {
        id: 'clientSecret',
        label: { en: 'OAuth client secret', 'zh-CN': 'OAuth 客户端密钥' },
        type: 'password' as const,
        required: true,
        description: { en: 'Copy the secret generated for the same OAuth client.', 'zh-CN': '复制同一个 OAuth 客户端生成的密钥。' }
      }
    ]
  },
  {
    id: 'retry_check',
    label: { en: 'Retry connection check', 'zh-CN': '重试连接检查' },
    description: { en: 'Refresh and verify your saved Gmail authorization.', 'zh-CN': '刷新并验证已保存的 Gmail 授权。' }
  },
  {
    id: 'retry_connect',
    label: { en: 'Retry Gmail connection', 'zh-CN': '重试 Gmail 连接' },
    description: {
      en: 'Retry with the OAuth client saved from the previous attempt. Use Connect Gmail to replace it.',
      'zh-CN': '使用上次保存的 OAuth 客户端重试；如需更换客户端，请选择“连接 Gmail”。'
    }
  }
] as const

const openAuthorization = (url: string): Effect.Effect<readonly IntegrationAction[], IntegrationError> =>
  Effect.try({
    try: () => new URL(url),
    catch: () => new IntegrationError({ message: 'Google returned an invalid authorization URL.' })
  }).pipe(
    Effect.flatMap((parsed) =>
      parsed.protocol === 'https:' && ['google.com', 'www.google.com', 'accounts.google.com'].some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))
        ? Effect.succeed([{ id: 'open_authorization', type: 'open-url' as const, url: parsed.toString(), primary: true }])
        : Effect.fail(new IntegrationError({ message: 'Google returned an unsafe authorization URL.' }))
    )
  )

const result = (state: string, actions: readonly IntegrationAction[] = []): CheckResult => ({ state, actions })

const connectActions = (hasSavedClient: boolean): readonly IntegrationAction[] => [
  // Make the credential form the prominent action. A saved client is useful
  // for an explicit retry, but it must never hide the way to replace stale
  // credentials behind the primary button.
  { id: 'connect', type: 'callback', primary: true },
  ...(hasSavedClient ? [{ id: 'retry_connect', type: 'callback' as const }] : []),
  { id: 'open_client_setup', type: 'open-url' as const, url: clientSetupUrl }
]

/** Creates a Gmail provider while keeping the host unaware of Google-specific state. */
const make = () => {
  const inspect = Effect.fn('GmailIntegration.inspect')(function* () {
    const context = yield* IntegrationContext
    const state = yield* readPrivateState(context.directory)
    if (!state.installed) return result('install_required', [{ id: 'install', type: 'callback', primary: true }])
    if (!state.credentials || !hasGmailScope(state.credentials.scope))
      return result('login_required', connectActions(!!state.oauthClient))
    // Expired or unverified access tokens still have a saved refresh grant. Retrying
    // verification must remain distinct from asking the user for a new browser grant.
    if (state.credentials.verified === false || state.credentials.expiresAt <= Date.now()) {
      return result('recovering', [
        { id: 'retry_check', type: 'callback', primary: true },
        ...connectActions(!!state.oauthClient).map(({ primary: _, ...action }) => action)
      ])
    }
    return result('ready')
  })
  const check = Effect.fn('GmailIntegration.check')(function* () {
    const context = yield* IntegrationContext
    const credentials = yield* maintainCredentials(context.directory)
    yield* verifyCredentials(credentials).pipe(
      // Keep the grant, but do not continue advertising a failed health check as ready.
      Effect.tapError(() => updatePrivateState(context.directory, { credentials: { ...credentials, verified: false } }))
    )
    if (credentials.verified === false) yield* updatePrivateState(context.directory, { credentials: { ...credentials, verified: true } })
  })
  const install = Effect.fn('GmailIntegration.install')(function* () {
    const context = yield* IntegrationContext
    yield* context.writeState('installing', {})
    for (const resource of resources) yield* context.registerResource(resource)
    yield* updatePrivateState(context.directory, { installed: true })
  })
  const connect = Effect.fn('GmailIntegration.connect')(function* (payload: unknown, retry = false) {
    const context = yield* IntegrationContext
    const state = yield* readPrivateState(context.directory)
    const values = retry
      ? yield* Schema.decodeUnknownEffect(GmailOAuthClient)(state.oauthClient).pipe(
          Effect.mapError(() => new IntegrationError({ message: 'No saved Gmail OAuth client is available. Use Connect Gmail to enter it again.' }))
        )
      : yield* Schema.decodeUnknownEffect(GmailOAuthClient)(payload).pipe(Effect.mapError(() => new IntegrationError({ message: 'Enter the Google OAuth client ID and secret.' })))
    const client: GmailOAuthClient = { clientId: values.clientId.trim(), clientSecret: values.clientSecret.trim() }
    if (!client.clientId || !client.clientSecret) return yield* new IntegrationError({ message: 'Enter the Google OAuth client ID and secret.' })
    // Persist the client before any network call. It is private state (0600) and
    // is removed once a verified refresh/access-token pair is saved.
    yield* updatePrivateState(context.directory, { oauthClient: client })
    const token = yield* authorizeDesktop(
      client.clientId,
      client.clientSecret,
      (url) =>
        Effect.gen(function* () {
          yield* context.writeState('waiting_for_user', {}, yield* openAuthorization(url))
        }),
      () => context.writeState('authorizing', {}, [])
    )
    const credentials = yield* Schema.decodeUnknownEffect(GmailCredentials)({
      ...token,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      scope: token.scope ?? gmailScope,
      verified: false
    })
    yield* verifyCredentials(credentials)
    yield* updatePrivateState(context.directory, { credentials: { ...credentials, verified: true }, oauthClient: undefined })
  })
  return defineIntegration({
    ...gmailMetadata,
    actions,
    resources,
    // Refresh only an explicitly installed provider when the host starts it.
    setup: () => Effect.gen(function* () {
      const context = yield* IntegrationContext
      if (!(yield* readPrivateState(context.directory)).installed) return
      for (const resource of resources) yield* context.registerResource(resource)
    }),
    install,
    check,
    inspect,
    onActionCallback: (id, payload) =>
      id === 'install'
        ? install()
        : id === 'retry_check'
          ? check()
          : id === 'connect'
          ? connect(payload)
          : id === 'retry_connect'
            ? connect(undefined, true)
            : Effect.fail(new IntegrationError({ message: 'Unknown Gmail action.' }))
  })
}

export const GmailIntegration = make()
