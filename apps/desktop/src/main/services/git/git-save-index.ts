import { Effect, FileSystem } from 'effect'
import { join } from 'node:path'
import type { GitChangePreparation } from '../../../shared/git-change'
import { HarnessStoreError } from '../../../shared/harness'
import { makeVaultGit } from './vault-git'

/** Reads staged content from a private copy, ignoring cache/stat refreshes without touching the real index. */
export const savedIndexTree = Effect.fn('GitSave.indexTree')(function*(cwd: string, bytes: Uint8Array) {
  const fs = yield* FileSystem.FileSystem
  const git = yield* makeVaultGit
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: 'folio-check-index-' })
  const indexFile = join(temporary, 'index')
  yield* fs.writeFile(indexFile, bytes)
  return (yield* git(cwd, ['write-tree'], { indexFile })).trim()
}, Effect.scoped)

/**
 * Builds a standalone index containing the saved paths plus every unselected staged draft.
 * Only the private index changes. Directory/file collisions and unresolved index entries fail
 * instead of removing unselected entries or guessing how to resolve them.
 */
export const prepareSaveIndex = Effect.fn('GitSave.prepareIndex')(function*(cwd: string, before: Uint8Array, change: GitChangePreparation) {
  const fs = yield* FileSystem.FileSystem
  const git = yield* makeVaultGit
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: 'folio-save-index-' })
  const indexFile = join(temporary, 'index')
  const options = { indexFile }
  yield* fs.writeFile(indexFile, before)
  // Persist a full index so recovery does not depend on a separately collected sharedindex file.
  yield* git(cwd, ['update-index', '--no-split-index'], options)
  const oldTree = (yield* git(cwd, ['write-tree'], options)).trim()
  const entries = yield* git(cwd, ['--literal-pathspecs', 'ls-tree', '-r', '-z', '--full-tree', change.tree, '--', ...change.paths])
  const remove = change.paths.map(path => `0 ${'0'.repeat(change.tree.length)}\t${path}\0`).join('')
  yield* git(cwd, ['update-index', '-z', '--index-info'], { indexFile, input: remove + entries })
  const nextTree = (yield* git(cwd, ['write-tree'], options)).trim()
  const changed = (yield* git(cwd, ['diff-tree', '--no-renames', '--no-commit-id', '--name-only', '-r', '-z', oldTree, nextTree]))
    .split('\0').filter(Boolean)
  if (changed.some(path => !change.paths.includes(path))) return yield* new HarnessStoreError({
    reason: 'invalid-state', message: 'Saving these files would change an unselected staged file.'
  })
  return yield* fs.readFile(indexFile)
}, Effect.scoped)
