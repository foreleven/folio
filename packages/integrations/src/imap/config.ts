import { Effect, Schema } from 'effect'
import { IntegrationError } from '../base/index.ts'

/** Only published provider endpoints are inferred; custom domains require an explicit host. */
const hosts: Readonly<Record<string, string>> = {
  'gmail.com': 'imap.gmail.com', 'googlemail.com': 'imap.gmail.com',
  'qq.com': 'imap.qq.com', 'foxmail.com': 'imap.qq.com',
  '163.com': 'imap.163.com', '126.com': 'imap.126.com', 'yeah.net': 'imap.yeah.net',
  'icloud.com': 'imap.mail.me.com', 'me.com': 'imap.mail.me.com', 'mac.com': 'imap.mail.me.com',
  'yahoo.com': 'imap.mail.yahoo.com', 'aol.com': 'imap.aol.com', 'fastmail.com': 'imap.fastmail.com'
}

export const ImapCredentials = Schema.Struct({
  user: Schema.NonEmptyString,
  password: Schema.NonEmptyString,
  host: Schema.NonEmptyString,
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  security: Schema.Literals(['tls', 'starttls']),
  mailbox: Schema.NonEmptyString,
  proxy: Schema.optional(Schema.NonEmptyString),
  verified: Schema.Boolean
})
export type ImapCredentials = typeof ImapCredentials.Type

/** Normalizes the credential form once, before any network call or state mutation. */
export const parseConnection = Effect.fn('Imap.parseConnection')(function* (payload: unknown) {
  const input = yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.String))(payload).pipe(
    Effect.mapError(() => new IntegrationError({ message: 'Enter the mailbox connection details.' })))
  const user = input.user?.trim() ?? ''
  const domain = user.split('@').at(-1)?.toLowerCase() ?? ''
  const host = input.host?.trim() || hosts[domain]
  if (!host) return yield* new IntegrationError({ message: 'Use Custom server / proxy to enter the IMAP server for this email provider.' })
  if (/[\s/:]/.test(host)) return yield* new IntegrationError({ message: 'Enter an IMAP hostname without a URL scheme or port.' })
  const security = input.security?.trim().toLowerCase() || 'tls'
  const proxy = input.proxy?.trim() || undefined
  if (proxy) {
    const valid = yield* Effect.try(() => new URL(proxy)).pipe(
      Effect.mapError(() => new IntegrationError({ message: 'Enter a valid HTTP CONNECT or SOCKS proxy URL.' })))
    if (!['http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:'].includes(valid.protocol)) {
      return yield* new IntegrationError({ message: 'Use an HTTP CONNECT or SOCKS proxy URL.' })
    }
  }
  // Google displays its generated app password in groups; the spaces are not part of it.
  const password = host === 'imap.gmail.com' ? input.password?.replace(/\s/g, '') : input.password
  return yield* Schema.decodeUnknownEffect(ImapCredentials)({
    user, password, host, security, proxy, verified: false,
    port: input.port?.trim() ? Number(input.port) : security === 'starttls' ? 143 : 993,
    mailbox: input.mailbox?.trim() || 'INBOX'
  }).pipe(Effect.mapError(() => new IntegrationError({ message: 'Enter a username, app password, valid port (1–65535), and security mode (tls or starttls).' })))
})
