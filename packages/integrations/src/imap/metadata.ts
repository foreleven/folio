import type { IntegrationMetadata } from '../base/index.ts'

const logo = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect x="4" y="8" width="40" height="32" rx="7" fill="#3875cb"/><path d="m10 15 14 11 14-11" fill="none" stroke="white" stroke-width="3" stroke-linejoin="round"/></svg>'

/** Public state never contains a username, password, proxy credential, or SDK diagnostic. */
export const imapMetadata = {
  id: 'imap', name: 'IMAP Mail',
  description: { en: 'Review email from Gmail, QQ, 163, or a custom IMAP server.', 'zh-CN': '连接 Gmail、QQ、163 或自定义 IMAP 邮箱，定时整理邮件。' },
  logo: `data:image/svg+xml,${encodeURIComponent(logo)}`,
  homepage: 'https://imapflow.com/',
  states: {
    install_required: { kind: 'attention', label: { en: 'Setup required', 'zh-CN': '需要安装' } },
    installing: { kind: 'working', label: { en: 'Installing', 'zh-CN': '正在安装' } },
    login_required: { kind: 'attention', label: { en: 'Connection required', 'zh-CN': '需要连接邮箱' } },
    connecting: { kind: 'working', label: { en: 'Connecting', 'zh-CN': '正在连接' } },
    recovering: { kind: 'unavailable', label: { en: 'Connection unavailable', 'zh-CN': '连接暂不可用' } },
    ready: { kind: 'ready', label: { en: 'Connected', 'zh-CN': '已连接' } }
  }
} satisfies IntegrationMetadata
