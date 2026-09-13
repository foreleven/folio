import { Effect, FileSystem, Schema } from 'effect'
import { dirname, join } from 'node:path'
import { IntegrationError } from '../base/index.ts'

/** OAuth client values supplied by the user; kept private while authorization is pending. */
export const GmailOAuthClient = Schema.Struct({
  clientId: Schema.NonEmptyString,
  clientSecret: Schema.NonEmptyString
})
export type GmailOAuthClient = typeof GmailOAuthClient.Type

export const GmailCredentials = Schema.Struct({
  clientId: Schema.NonEmptyString,
  clientSecret: Schema.NonEmptyString,
  accessToken: Schema.NonEmptyString,
  refreshToken: Schema.NonEmptyString,
  expiresAt: Schema.Number,
  scope: Schema.optional(Schema.String),
  /** False is persisted during token rotation until the new token is verified. */
  verified: Schema.optional(Schema.Boolean)
})
export type GmailCredentials = typeof GmailCredentials.Type

export const GmailPrivateState = Schema.Struct({
  version: Schema.Literal(1),
  installed: Schema.Boolean,
  /** Saved before starting OAuth so failed attempts can be retried. */
  oauthClient: Schema.optional(GmailOAuthClient),
  credentials: Schema.optional(GmailCredentials)
})
export type GmailPrivateState = typeof GmailPrivateState.Type
export type GmailPrivateStatePatch = Partial<Omit<GmailPrivateState, 'version'>>

const pathFor = (directory: string) => join(directory, 'private.json')

/** Reads Gmail's one known state file; malformed state never exposes its contents. */
export const readPrivateState = Effect.fn('Gmail.readPrivateState')(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  const path = pathFor(directory)
  const text = yield* fs.readFileString(path).pipe(Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed(undefined)))
  if (text === undefined) return { version: 1 as const, installed: false } satisfies GmailPrivateState
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(GmailPrivateState))(text).pipe(
    Effect.mapError(() => new IntegrationError({ message: `Invalid Gmail integration state: ${path}` }))
  )
})

/** Atomically replaces private state and leaves a complete previous document on interruption. */
const writeState = Effect.fn('Gmail.writeState')(function* (directory: string, value: GmailPrivateState) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
  yield* fs.chmod(directory, 0o700)
  const temporary = yield* fs.makeTempDirectoryScoped({ directory: dirname(pathFor(directory)), prefix: '.gmail-state-' })
  const staged = join(temporary, 'private.json')
  yield* fs.writeFileString(staged, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  yield* fs.rename(staged, pathFor(directory)).pipe(Effect.uninterruptible)
}, Effect.scoped)

export const updatePrivateState = Effect.fn('Gmail.updatePrivateState')(function* (directory: string, patch: GmailPrivateStatePatch) {
  const current = yield* readPrivateState(directory)
  const next = { ...current, ...patch, version: 1 as const } satisfies GmailPrivateState
  yield* writeState(directory, next)
  return next
})
