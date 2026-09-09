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

export const LarkPrivateState = Schema.Struct({
  version: Schema.Literal(1),
  installed: Schema.Boolean,
  app: Schema.optional(LarkApp),
  appAuth: Schema.optional(AppAuth),
  userAuth: Schema.optional(UserAuth)
})
export type LarkPrivateState = typeof LarkPrivateState.Type
export type LarkPrivateStatePatch = Partial<Omit<LarkPrivateState, 'version'>>

const fileName = 'private.json'
const legacyFiles = ['installed.json', 'app.json', 'app-auth.json', 'auth.json'] as const

/** Reads one known JSON document; only missing files mean no saved state, malformed state remains an error. */
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

/** Atomically stores a private JSON document; interrupted writes preserve the previous complete value. */
export const writeState = Effect.fn('Lark.writeState')(function*(path: string, value: unknown) {
  const fs = yield* FileSystem.FileSystem
  const temporary = yield* fs.makeTempDirectoryScoped({ directory: dirname(path), prefix: '.state-' })
  const staged = join(temporary, 'state.json')
  yield* fs.writeFileString(staged, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  yield* fs.rename(staged, path).pipe(Effect.uninterruptible)
}, Effect.scoped)

/** Reconstructs the former four-file layout without modifying it, preserving read-only inspection. */
const readLegacyState = Effect.fn('Lark.readLegacyState')(function*(directory: string) {
  const installed = yield* readState(join(directory, 'installed.json'), Schema.Boolean)
  const app = yield* readState(join(directory, 'app.json'), LarkApp)
  const appAuth = yield* readState(join(directory, 'app-auth.json'), AppAuth)
  const userAuth = yield* readState(join(directory, 'auth.json'), UserAuth)
  return { version: 1, installed: installed === true, app, appAuth, userAuth } satisfies LarkPrivateState
})

/** Reads the consolidated state, falling back to legacy documents until migration can write safely. */
export const readPrivateState = Effect.fn('Lark.readPrivateState')(function*(directory: string) {
  return (yield* readState(join(directory, fileName), LarkPrivateState)) ?? (yield* readLegacyState(directory))
})

/** Removes obsolete documents only after the consolidated replacement is durable. */
const removeLegacyState = Effect.fn('Lark.removeLegacyState')(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  for (const legacy of legacyFiles) yield* fs.remove(join(directory, legacy), { force: true })
})

/** Commits a partial logical update as one atomic document and retires the former split layout. */
export const updatePrivateState = Effect.fn('Lark.updatePrivateState')(function*(directory: string, patch: LarkPrivateStatePatch) {
  const current = yield* readPrivateState(directory)
  const next = { ...current, ...patch, version: 1 as const } satisfies LarkPrivateState
  yield* writeState(join(directory, fileName), next)
  yield* removeLegacyState(directory).pipe(
    Effect.catch(() => Effect.logWarning('Obsolete Lark state files could not be removed'))
  )
  return next
})

/** Migrates an existing installation once at provider startup without creating state for new catalog entries. */
export const migratePrivateState = Effect.fn('Lark.migratePrivateState')(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  if (yield* fs.exists(join(directory, fileName))) return false
  let hasLegacyState = false
  for (const legacy of legacyFiles) {
    if (yield* fs.exists(join(directory, legacy))) {
      hasLegacyState = true
      break
    }
  }
  if (!hasLegacyState) return false
  yield* updatePrivateState(directory, {})
  yield* Effect.logInfo('Lark private state migrated to the consolidated format')
  return true
})
