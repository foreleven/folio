import type { IntegrationMetadata } from '../base/index.ts'

// Keep the logo self-contained so the renderer never needs a network request.
const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path fill="#EA4335" d="M5 9.5A4.5 4.5 0 0 1 9.5 5h29A4.5 4.5 0 0 1 43 9.5v29a4.5 4.5 0 0 1-4.5 4.5h-29A4.5 4.5 0 0 1 5 38.5z"/><path fill="#fff" d="M10 13.4 24 24l14-10.6V35h-5.2V20.2L24 27.6l-8.8-7.4V35H10z"/></svg>`

/** Public Gmail identity and state presentation; credentials remain provider-private. */
export const gmailMetadata = {
  id: 'gmail',
  name: 'Google Gmail',
  description: {
    en: 'Bring your daily Gmail into a reviewable routine.',
    'zh-CN': '把每天的 Gmail 邮件带入可复核的整理流程。'
  },
  logo: `data:image/svg+xml,${encodeURIComponent(logo)}`,
  homepage: 'https://mail.google.com/',
  states: {
    install_required: { kind: 'attention', label: { en: 'Setup required', 'zh-CN': '需要安装' } },
    installing: { kind: 'working', label: { en: 'Installing', 'zh-CN': '正在安装' } },
    login_required: { kind: 'attention', label: { en: 'Authorization required', 'zh-CN': '需要授权' } },
    waiting_for_user: {
      kind: 'waiting',
      label: { en: 'Waiting for Google authorization', 'zh-CN': '等待 Google 授权' },
      description: { en: 'Complete the Google consent page in your browser to approve Gmail access.', 'zh-CN': '在浏览器完成 Google 同意页面并允许访问 Gmail。' }
    },
    authorizing: { kind: 'working', label: { en: 'Connecting Gmail', 'zh-CN': '正在连接 Gmail' } },
    recovering: {
      kind: 'unavailable',
      label: { en: 'Reconnecting', 'zh-CN': '正在恢复连接' },
      description: { en: 'Gmail authorization is temporarily unavailable; try again shortly.', 'zh-CN': 'Gmail 授权暂时不可用，请稍后重试。' }
    },
    ready: { kind: 'ready', label: { en: 'Connected', 'zh-CN': '已连接' } }
  }
} satisfies IntegrationMetadata
