import { Effect, FileSystem, Schema } from 'effect'
import { dirname, join } from 'node:path'
import { IntegrationError } from '../base/index.ts'
import { ImapCredentials } from './config.ts'

export const ImapPrivateState = Schema.Struct({
  version: Schema.Literal(1),
  installed: Schema.Boolean,
  credentials: Schema.optional(ImapCredentials)
})
export type ImapPrivateState = typeof ImapPrivateState.Type
export type ImapPrivateStatePatch = Partial<Omit<ImapPrivateState, 'version'>>

const pathFor = (directory: string) => join(directory, 'private.json')

/** Reads IMAP's private state; malformed state never exposes its contents. */
export const readPrivateState = Effect.fn('Imap.readPrivateState')(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  const path = pathFor(directory)
  const text = yield* fs.readFileString(path).pipe(Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed(undefined)))
  if (text === undefined) return { version: 1 as const, installed: false } satisfies ImapPrivateState
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ImapPrivateState))(text).pipe(
    Effect.mapError(() => new IntegrationError({ message: `Invalid IMAP integration state: ${path}` }))
  )
})

/** Atomically replaces private state and leaves a complete previous document on interruption. */
const writeState = Effect.fn('Imap.writeState')(function* (directory: string, value: ImapPrivateState) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
  yield* fs.chmod(directory, 0o700)
  const temporary = yield* fs.makeTempDirectoryScoped({ directory: dirname(pathFor(directory)), prefix: '.imap-state-' })
  const staged = join(temporary, 'private.json')
  yield* fs.writeFileString(staged, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  yield* fs.rename(staged, pathFor(directory)).pipe(Effect.uninterruptible)
}, Effect.scoped)

export const updatePrivateState = Effect.fn('Imap.updatePrivateState')(function* (directory: string, patch: ImapPrivateStatePatch) {
  const current = yield* readPrivateState(directory)
  const next = { ...current, ...patch, version: 1 as const } satisfies ImapPrivateState
  yield* writeState(directory, next)
  return next
})
