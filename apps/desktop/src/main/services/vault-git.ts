import { Effect, Schema, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import { devNull } from 'node:os'
import { isAbsolute } from 'node:path'

export class VaultGitError extends Schema.TaggedError<VaultGitError>()('VaultGitError', { message: Schema.String }) {}
/** Creates a Git runner whose commands cannot inherit another repository's location or user hooks. */
export const makeVaultGit = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key, value]) => !key.toUpperCase().startsWith('GIT_') && value !== undefined)
    ),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_NO_REPLACE_OBJECTS: '1'
  }
  /** Stream EOF is not success: wait for the actual exit code, with bounded cleanup on failure. */
  return Effect.fn('VaultGit.run')(
    function* (
      cwd: string,
      args: readonly string[],
      options?: { readonly indexFile?: string; readonly input?: string }
    ) {
      // Only Folio's explicit temporary index may override the sanitized Git environment.
      if (options?.indexFile !== undefined && !isAbsolute(options.indexFile))
        return yield* Effect.fail(new Error('Absolute index path required'))
      const child = yield* spawner.spawn(
        ChildProcess.make(
          'git',
          [
            '-c',
            'core.fsmonitor=false',
            '-c',
            'commit.gpgSign=false',
            '-c',
            'core.hooksPath=',
            '-c',
            'user.name=Folio',
            '-c',
            'user.email=folio@localhost',
            ...args
          ],
          {
            cwd,
            env: options?.indexFile ? { ...env, GIT_INDEX_FILE: options.indexFile } : env,
            stdin: options?.input === undefined ? 'ignore' : Stream.succeed(new TextEncoder().encode(options.input)),
            extendEnv: false,
            forceKillAfter: '2 seconds'
          }
        )
      )
      yield* child.stderr.pipe(Stream.runDrain, Effect.forkScoped)
      const output = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString)
      if ((yield* child.exitCode) !== 0) return yield* Effect.fail(new Error('Git operation failed'))
      return output
    },
    Effect.scoped,
    Effect.timeout('15 seconds'),
    Effect.mapError(() => new VaultGitError({ message: 'Vault Git operation failed.' }))
  )
})
