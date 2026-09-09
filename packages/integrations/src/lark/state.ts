import { Effect, FileSystem, Schema } from 'effect'
import { dirname, join } from 'node:path'
import { IntegrationError } from '../base/index.ts'

export const LarkApp = Schema.Struct({
  clientId: Schema.NonEmptyString,
  clientSecret: Schema.NonEmptyString,
  brand: Schema.Literals(['feishu', 'lark'])
})
export type LarkApp = typeof LarkApp.Type

export const AppAuth = Schema.Struct({
  clientId: Schema.NonEmptyString,
  brand: Schema.Literals(['feishu', 'lark']),
  appAccessToken: Schema.NonEmptyString,
  tenantAccessToken: Schema.optional(Schema.NonEmptyString),
  expiresAt: Schema.Number
})
export type AppAuth = typeof AppAuth.Type

export const UserAuth = Schema.Struct({
  clientId: Schema.NonEmptyString,
  brand: Schema.Literals(['feishu', 'lark']),
  accessToken: Schema.NonEmptyString,
  expiresAt: Schema.Number,
  refreshToken: Schema.optional(Schema.String),
  refreshExpiresAt: Schema.optional(Schema.Number),
  scope: Schema.optional(Schema.String),
  verified: Schema.optional(Schema.Boolean),
  openId: Schema.NonEmptyString
})
export type UserAuth = typeof UserAuth.Type

/** Reads one known state document; only missing files mean no saved state, malformed state remains an error. */
export const readState = Effect.fn('Lark.readState')(function*<A>(path: string, schema: Schema.Codec<A, unknown>) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(path).pipe(
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed(undefined))
  )
  if (text === undefined) return undefined
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
    // Schema parse errors can embed secrets; expose only the affected path.
    Effect.mapError(() => new IntegrationError({ message: `Invalid integration state: ${path}` }))
  )
})

/** Atomically stores private state; failed/interrupted writes preserve the previous complete document. */
export const writeState = Effect.fn('Lark.writeState')(function*(path: string, value: unknown) {
  const fs = yield* FileSystem.FileSystem
  const temporary = yield* fs.makeTempDirectoryScoped({ directory: dirname(path), prefix: '.state-' })
  const staged = join(temporary, 'state.json')
  yield* fs.writeFileString(staged, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  yield* fs.rename(staged, path).pipe(Effect.uninterruptible)
}, Effect.scoped)
