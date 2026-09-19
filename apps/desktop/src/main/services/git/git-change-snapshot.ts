import { Effect, FileSystem, Schema } from 'effect'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { HarnessStoreError } from '../../../shared/harness'
import { GitObjectId, GitSelectedPath } from '../../../shared/git-change'
import { makeVaultGit } from './vault-git'

const Input = Schema.Struct({
  cwd: Schema.NonEmptyString,
  parent: GitObjectId,
  paths: Schema.NonEmptyArray(GitSelectedPath)
})
const invalid = () =>
  new HarnessStoreError({
    reason: 'invalid-state',
    message: 'Selected files or Git baseline changed. Review the changes again.'
  })

/** Captures selected file paths into an immutable Git tree using a private index.
 * Caller supplies a verified checkout and frozen parent under its operation lock. This does not
 * move refs, alter the real index, commit, or assert that native writers have stopped.
 * Git attributes/clean filters apply as with git add. The returned tree has no retention ref;
 * a save coordinator must journal and protect it before relying on it for crash recovery.
 */
export const snapshotGitChange = Effect.fn('GitChange.snapshot')(
  function* (input: typeof Input.Type) {
    const value = yield* Schema.decodeUnknownEffect(Input)(input, { onExcessProperty: 'error' })
    const fs = yield* FileSystem.FileSystem
    const git = yield* makeVaultGit
    const cwd = yield* fs.realPath(value.cwd)
    if (
      (yield* git(cwd, ['rev-parse', '--show-toplevel'])).trim() !== cwd ||
      (yield* git(cwd, ['rev-parse', 'HEAD'])).trim() !== value.parent
    )
      return yield* invalid()
    const paths = [...new Set(value.paths)].sort()
    // Reject directories and redirected ancestors: selecting one file must never stage a subtree.
    for (const path of paths) {
      const parts = path.split('/')
      for (let index = 0; index < parts.length; index++) {
        const target = join(cwd, ...parts.slice(0, index + 1))
        const info = yield* Effect.tryPromise(() =>
          lstat(target).catch((error) => {
            if (error.code === 'ENOENT') return null
            throw error
          })
        )
        if (info && (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())))
          return yield* invalid()
      }
    }
    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: 'folio-git-index-' })
    const options = { indexFile: join(temporary, 'index') }
    yield* git(cwd, ['read-tree', value.parent], options)
    // Literal pathspecs prevent names like [draft].md or leading ':' from selecting other files.
    yield* git(cwd, ['--literal-pathspecs', 'add', '-A', '--', ...paths], options)
    const tree = (yield* git(cwd, ['write-tree'], options)).trim()
    yield* Schema.decodeUnknownEffect(GitObjectId)(tree)
    const changed = (yield* git(cwd, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', value.parent, tree]))
      .split('\0')
      .filter(Boolean)
    if (
      changed.some((path) => !paths.includes(path)) ||
      (yield* git(cwd, ['rev-parse', 'HEAD'])).trim() !== value.parent
    )
      return yield* invalid()
    return { parent: value.parent, tree, paths, changed }
  },
  Effect.scoped,
  Effect.mapError((error) => (error instanceof HarnessStoreError ? error : invalid()))
)
