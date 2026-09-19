import { Effect } from 'effect'
import { ImapFlow } from 'imapflow'
import { IntegrationError } from '../base/index.ts'
import type { ImapCredentials } from './config.ts'

/** Verifies login and the selected folder without marking messages as read. */
export const verifyCredentials = Effect.fn('Imap.verifyCredentials')(function* (credentials: ImapCredentials) {
  const client = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const connection = new ImapFlow({
        host: credentials.host, port: credentials.port,
        secure: credentials.security === 'tls',
        doSTARTTLS: credentials.security === 'starttls' ? true : undefined,
        auth: { user: credentials.user, pass: credentials.password },
        proxy: credentials.proxy, logger: false, disableAutoIdle: true,
        connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000
      })
      // Command promises report transport failures; never print SDK errors containing auth data.
      connection.on('error', () => {})
      return connection
    }),
    connection => Effect.sync(() => connection.close())
  )
  yield* Effect.tryPromise({
    try: async () => {
      await client.connect()
      await client.mailboxOpen(credentials.mailbox, { readOnly: true })
      await client.logout()
    },
    catch: () => new IntegrationError({ message: 'Could not connect to the IMAP folder. Check the server, app password, IMAP access, and network/proxy settings.' })
  }).pipe(Effect.timeout('45 seconds'), Effect.mapError(error => error instanceof IntegrationError ? error
    : new IntegrationError({ message: 'IMAP connection timed out. Check the network and proxy settings.' })))
}, Effect.scoped)
