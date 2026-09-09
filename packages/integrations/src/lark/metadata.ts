import type { IntegrationMetadata } from '../base/index.ts'

// Keep the image self-contained: the desktop renderer cannot load main-process file paths.
const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none"><path d="M5 10h10l6 7H11z" fill="#00B5E5"/><path d="m11 17 6 7L28 7H17l-6 10Z" fill="#1685FF"/></svg>`

export const larkMetadata = {
  id: 'lark',
  name: 'Lark',
  description: '连接 Lark，让 Folio 可以访问你的会话和邮件。',
  logo: `data:image/svg+xml,${encodeURIComponent(logo)}`,
  homepage: 'https://www.larksuite.com/'
} satisfies IntegrationMetadata
