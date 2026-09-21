import { Effect } from 'effect'
import { defineIntegration, IntegrationContext, IntegrationError } from '../base/index.ts'
import type { CheckResult, IntegrationAction } from '../base/index.ts'
import { imapMetadata } from './metadata.ts'
import { readPrivateState, updatePrivateState } from './state.ts'
import { parseConnection } from './config.ts'
import { verifyCredentials } from './client.ts'
import { ingestImap } from './ingest.ts'

const resources = [{
  id: 'email', type: 'email' as const,
  name: { en: 'IMAP email', 'zh-CN': 'IMAP 邮件' },
  onIngest: () => Effect.void,
  ingest: ingestImap
}] as const

const credentialFields = [
  { id: 'user', label: { en: 'Email / username', 'zh-CN': '邮箱地址 / 用户名' }, type: 'text' as const, required: true },
  { id: 'password', label: { en: 'App password / authorization code', 'zh-CN': '应用专用密码 / 授权码' }, type: 'password' as const, required: true }
] as const
const connectionDescription = {
  en: 'Use an app password or IMAP authorization code. Gmail requires 2-Step Verification; QQ/163 require IMAP enabled. Reads INBOX by default. OAuth-only accounts are not supported yet.',
  'zh-CN': '填写应用专用密码或 IMAP 授权码。Gmail 需开启两步验证；QQ/163 需启用 IMAP。默认只读收件箱。暂不支持强制 OAuth 登录的账号。'
}
const actions = [
  { id: 'install', label: { en: 'Install', 'zh-CN': '安装' } },
  {
    id: 'connect', label: { en: 'Connect mailbox', 'zh-CN': '连接邮箱' },
    description: connectionDescription,
    fields: credentialFields
  },
  {
    id: 'connect_custom', label: { en: 'Custom server / proxy', 'zh-CN': '自定义服务器 / 代理' },
    description: connectionDescription,
    fields: [
      ...credentialFields,
      { id: 'host', label: { en: 'IMAP server (optional)', 'zh-CN': 'IMAP 服务器（可选）' }, type: 'text' as const, required: false,
        description: { en: 'Detected for Gmail, QQ, 163, 126, iCloud, Yahoo, AOL, and Fastmail. Required for custom domains.', 'zh-CN': 'Gmail、QQ、163、126、iCloud、Yahoo、AOL、Fastmail 自动识别；企业或自定义域名请填写。' } },
      { id: 'port', label: { en: 'Port (optional)', 'zh-CN': '端口（可选）' }, type: 'text' as const, required: false,
        description: { en: 'Default: 993 for TLS, 143 for STARTTLS.', 'zh-CN': 'TLS 默认 993，STARTTLS 默认 143。' } },
      { id: 'security', label: { en: 'Security (optional)', 'zh-CN': '加密方式（可选）' }, type: 'text' as const, required: false,
        description: { en: 'tls (default) or starttls. Encryption is always required.', 'zh-CN': '默认 tls；如服务器要求升级加密，填 starttls。' } },
      { id: 'mailbox', label: { en: 'Folder (optional)', 'zh-CN': '邮件文件夹（可选）' }, type: 'text' as const, required: false,
        description: { en: 'Default: INBOX. Enter the exact IMAP folder path for another folder.', 'zh-CN': '默认 INBOX（收件箱）；其他文件夹请填写完整 IMAP 路径。' } },
      { id: 'proxy', label: { en: 'Proxy URL (optional)', 'zh-CN': '代理地址（可选）' }, type: 'password' as const, required: false,
        description: { en: 'For example socks5://127.0.0.1:1080 or http://127.0.0.1:7890. Blank connects directly.', 'zh-CN': '例如 socks5://127.0.0.1:1080 或 http://127.0.0.1:7890；留空直接连接。' } }
    ]
  },
  { id: 'retry_check', label: { en: 'Retry connection', 'zh-CN': '重试连接' } },
  { id: 'disconnect', label: { en: 'Disconnect', 'zh-CN': '断开连接' } }
] as const

const result = (state: string, actions: readonly IntegrationAction[] = []): CheckResult => ({ state, actions })

const inspect = Effect.fn('Imap.inspect')(function* () {
  const context = yield* IntegrationContext
  const state = yield* readPrivateState(context.directory)
  if (!state.installed) return result('install_required', [{ id: 'install', type: 'callback', primary: true }])
  if (!state.credentials) return result('login_required', [
    { id: 'connect', type: 'callback', primary: true }, { id: 'connect_custom', type: 'callback' }
  ])
  const actions: IntegrationAction[] = [
    { id: 'connect', type: 'callback' }, { id: 'connect_custom', type: 'callback' }, { id: 'disconnect', type: 'callback' }
  ]
  return state.credentials.verified ? result('ready', actions)
    : result('recovering', [{ id: 'retry_check', type: 'callback', primary: true }, ...actions])
})

const check = Effect.fn('Imap.check')(function* () {
  const context = yield* IntegrationContext
  const { credentials } = yield* readPrivateState(context.directory)
  if (!credentials) return yield* new IntegrationError({ message: 'Connect the IMAP mailbox first.' })
  yield* verifyCredentials(credentials).pipe(
    Effect.tapError(() => updatePrivateState(context.directory, { credentials: { ...credentials, verified: false } })))
  if (!credentials.verified) yield* updatePrivateState(context.directory, { credentials: { ...credentials, verified: true } })
})

const install = Effect.fn('Imap.install')(function* () {
  const context = yield* IntegrationContext
  yield* context.writeState('installing', {})
  for (const resource of resources) yield* context.registerResource(resource)
  yield* updatePrivateState(context.directory, { installed: true })
})

const connect = Effect.fn('Imap.connect')(function* (payload: unknown) {
  const context = yield* IntegrationContext
  const credentials = yield* parseConnection(payload)
  // Save before checking so a temporary network failure can be retried without retyping secrets.
  yield* updatePrivateState(context.directory, { credentials })
  yield* context.writeState('connecting', {})
  yield* check()
})

export const ImapIntegration = defineIntegration({
  ...imapMetadata, resources, actions, inspect, check, install,
  setup: Effect.fn('Imap.setup')(function* () {
    const context = yield* IntegrationContext
    if (!(yield* readPrivateState(context.directory)).installed) return
    for (const resource of resources) yield* context.registerResource(resource)
  }),
  onActionCallback: (id, payload) => id === 'install' ? install()
    : id === 'connect' || id === 'connect_custom' ? connect(payload)
    : id === 'retry_check' ? check()
    : id === 'disconnect' ? Effect.gen(function* () {
      const context = yield* IntegrationContext
      yield* updatePrivateState(context.directory, { credentials: undefined })
    })
    : Effect.fail(new IntegrationError({ message: 'Unknown IMAP action.' }))
})
