import { expect, it } from 'vitest'
import { NodeServices } from '@effect/platform-node'
import { Console, Effect, Schema } from 'effect'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { IntegrationContext, IntegrationError } from '../src/base/index.ts'
import { lark } from '../src/lark/index.ts'
import { findCli } from '../src/lark/cli.ts'
import { AppAuth, LarkApp, readState, UserAuth } from '../src/lark/state.ts'

const execute = promisify(execFile)
const CliResult = Schema.Struct({
  error: Schema.optional(Schema.Unknown),
  chats: Schema.optional(Schema.Array(Schema.Unknown)),
  items: Schema.optional(Schema.Array(Schema.Unknown)),
  data: Schema.optional(Schema.Struct({
    chats: Schema.optional(Schema.Array(Schema.Unknown)),
    items: Schema.optional(Schema.Array(Schema.Unknown))
  }))
})

/** Live read-only smoke test: proves saved credentials work in the CLI without printing personal data or tokens. */
it.skipIf(process.env.FOLIO_LARK_LIVE !== '1')('reads IM and Email using the saved Lark installation', async ({ signal }) => {
  await Effect.runPromise(Effect.gen(function*() {
    const directory = join(process.env.FOLIO_CONFIG_DIR || join(homedir(), '.folio'), 'integrations', 'lark')
    const result = yield* lark.inspect().pipe(Effect.provideService(IntegrationContext, { directory, writeState: () => Effect.void, registerResource: () => Effect.void }))
    expect(result.state, 'Complete Lark setup before running live verification').toBe('ready')
    const app = yield* readState(join(directory, 'app.json'), LarkApp)
    const appAuth = yield* readState(join(directory, 'app-auth.json'), AppAuth)
    const user = yield* readState(join(directory, 'auth.json'), UserAuth)
    const command = yield* findCli(directory)
    if (!app || !appAuth || !user || !command) return yield* new IntegrationError({ message: 'Integration credentials are missing.' })
    // Environment is scoped to each child process. The user's global CLI account is untouched.
    const env = {
      ...process.env,
      LARKSUITE_CLI_APP_ID: app.clientId, LARKSUITE_CLI_APP_SECRET: app.clientSecret,
      LARKSUITE_CLI_BRAND: app.brand, LARKSUITE_CLI_DEFAULT_AS: 'user',
      LARKSUITE_CLI_USER_ACCESS_TOKEN: user.accessToken,
      LARKSUITE_CLI_TENANT_ACCESS_TOKEN: appAuth.tenantAccessToken ?? appAuth.appAccessToken
    }
    const probes = [
      { id: 'im', args: ['im', '+chat-list', '--as', 'user', '--page-size', '1', '--types', 'p2p,group', '--json'] },
      { id: 'email', args: ['mail', 'user_mailbox.messages', 'list', '--as', 'user', '--user-mailbox-id', 'me', '--folder-id', 'INBOX', '--page-size', '1', '--json'] }
    ]
    for (const probe of probes) {
      const output = yield* Effect.tryPromise({
        try: (signal) => execute(command, probe.args, { env, signal, timeout: 30_000, maxBuffer: 1024 * 1024 }),
        catch: () => new IntegrationError({ message: `Lark ${probe.id} CLI read failed. Verify resource permissions and availability.` })
      })
      const body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CliResult))(output.stdout).pipe(
        Effect.mapError(() => new IntegrationError({ message: `Invalid ${probe.id} CLI response.` }))
      )
      const items = body.chats ?? body.items ?? body.data?.chats ?? body.data?.items
      if (body.error || !items) return yield* new IntegrationError({ message: `Lark ${probe.id} read did not return a successful listing.` })
      expect(items.length).toBeLessThanOrEqual(1)
      yield* Console.log(`${probe.id}: read succeeded (${items.length} item in verification page; content omitted)`)
    }
  }).pipe(Effect.provide(NodeServices.layer)), { signal })
}, 90_000)
