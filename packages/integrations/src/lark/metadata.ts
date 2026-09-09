import type { IntegrationMetadata } from '../base/index.ts'

// Keep the image self-contained: the desktop renderer cannot load main-process file paths.
const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none"><path d="M5 10h10l6 7H11z" fill="#00B5E5"/><path d="m11 17 6 7L28 7H17l-6 10Z" fill="#1685FF"/></svg>`

export const larkMetadata = {
  id: 'lark',
  name: 'Lark',
  description: { en: 'Connect your conversations and email.', 'zh-CN': '连接你的会话与邮件。' },
  logo: `data:image/svg+xml,${encodeURIComponent(logo)}`,
  homepage: 'https://www.larksuite.com/',
  states: {
    install_required: { kind: 'attention', label: { en: 'Setup required', 'zh-CN': '需要安装' } },
    installing: { kind: 'working', label: { en: 'Installing', 'zh-CN': '正在安装' } },
    app_required: { kind: 'attention', label: { en: 'Not connected', 'zh-CN': '尚未连接' } },
    creating_app: { kind: 'working', label: { en: 'Preparing connection', 'zh-CN': '正在准备连接' } },
    waiting_for_app: { kind: 'waiting', label: { en: 'Waiting for approval', 'zh-CN': '等待授权' },
      description: { en: 'Complete application approval in your browser. This card updates automatically.', 'zh-CN': '请在浏览器中完成应用授权，状态将自动更新。' } },
    verifying_app: { kind: 'working', label: { en: 'Connecting', 'zh-CN': '正在连接' } },
    login_required: { kind: 'attention', label: { en: 'Authorization required', 'zh-CN': '需要授权' } },
    app_authorization_required: { kind: 'attention', label: { en: 'Connection needs attention', 'zh-CN': '连接需要处理' } },
    authorizing: { kind: 'working', label: { en: 'Preparing authorization', 'zh-CN': '正在准备授权' } },
    waiting_for_user: { kind: 'waiting', label: { en: 'Waiting for authorization', 'zh-CN': '等待用户授权' },
      description: { en: 'Authorize access in your browser. This card updates automatically.', 'zh-CN': '请在浏览器中授权访问，状态将自动更新。' } },
    recovering: { kind: 'unavailable', label: { en: 'Reconnecting', 'zh-CN': '正在恢复连接' },
      description: { en: 'Connection temporarily unavailable. Retrying automatically.', 'zh-CN': '连接暂不可用，正在自动重试。' } },
    ready: { kind: 'ready', label: { en: 'Connected', 'zh-CN': '已连接' } }
  }
} satisfies IntegrationMetadata
