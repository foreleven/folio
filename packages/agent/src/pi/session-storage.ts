import { parseSessionEntries, SessionManager } from '@earendil-works/pi-coding-agent'
import { chmod, lstat, mkdir, open, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { Effect, Schema } from 'effect'

/** Identifies a native Pi session independently of Folio's and ACP's session IDs. */
export const PiSessionIdentity = Schema.Struct({
  nativeSessionId: Schema.NonEmptyString,
  nativeSessionFile: Schema.NonEmptyString
})
export type PiSessionIdentity = typeof PiSessionIdentity.Type

/** Storage errors intentionally exclude paths, parsed messages and underlying SDK errors. */
export class PiSessionStorageError extends Schema.TaggedError<PiSessionStorageError>()('PiSessionStorageError', {
  reason: Schema.Literals([
    'invalid_path',
    'session_missing',
    'identity_mismatch',
    'cwd_mismatch',
    'invalid_session',
    'storage_unavailable'
  ]),
  message: Schema.String
}) {}

const failure = (reason: PiSessionStorageError['reason']) =>
  new PiSessionStorageError({
    reason,
    message: 'Pi session storage could not create or restore the requested session.'
  })

/** Checks lexical containment before reading a file; real-path containment is checked separately. */
const within = (directory: string, file: string): boolean => {
  const path = relative(directory, file)
  return (
    path !== '' &&
    path !== '..' &&
    !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(path)
  )
}

/**
 * Creates durable Pi metadata before the first prompt, or restores an exact existing native identity.
 * The SDK owns the JSONL format; Folio writes only the SDK-produced initial header, then reopens it
 * so subsequent user messages are persisted even before any assistant response arrives.
 */
export const openPiSessionStorage = Effect.fn('PiSessionStorage.open')(
  (options: { readonly cwd: string; readonly directory: string; readonly resume?: PiSessionIdentity }) =>
    Effect.tryPromise({
      try: async () => {
        const { cwd, directory, resume } = options
        if (!isAbsolute(cwd) || !isAbsolute(directory)) throw failure('invalid_path')
        if (resume !== undefined) {
          if (!isAbsolute(resume.nativeSessionFile) || !within(directory, resume.nativeSessionFile)) {
            throw failure('invalid_path')
          }
          // SessionManager.open creates missing files/sessions. Check before calling it, without mkdir.
          const info = await lstat(resume.nativeSessionFile).catch((error: unknown) => {
            if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
              throw failure('session_missing')
            }
            throw error
          })
          if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw failure('invalid_session')
          if (!within(await realpath(directory), await realpath(resume.nativeSessionFile)))
            throw failure('invalid_path')
          const entries = parseSessionEntries(await readFile(resume.nativeSessionFile, 'utf8'))
          const header = entries[0]
          if (header?.type !== 'session') throw failure('invalid_session')
          if (header.id !== resume.nativeSessionId) throw failure('identity_mismatch')
          // Recreated worktrees may not exist yet, so compare normalized paths rather than requiring realpath(cwd).
          if (resolve(header.cwd) !== resolve(cwd)) throw failure('cwd_mismatch')
          await chmod(resume.nativeSessionFile, 0o600)
          return SessionManager.open(resume.nativeSessionFile, directory)
        }

        await mkdir(directory, { recursive: true, mode: 0o700 })
        const info = await lstat(directory)
        if (!info.isDirectory() || info.isSymbolicLink()) throw failure('invalid_path')
        await chmod(directory, 0o700)
        const session = SessionManager.create(cwd, directory)
        const file = session.getSessionFile()
        const header = session.getHeader()
        if (!file || !header) throw failure('invalid_session')
        const handle = await open(file, 'wx', 0o600)
        try {
          await handle.writeFile(`${JSON.stringify(header)}\n`)
          await handle.sync()
        } finally {
          await handle.close()
        }
        return SessionManager.open(file, directory)
      },
      catch: (error) => (error instanceof PiSessionStorageError ? error : failure('storage_unavailable'))
    })
)
