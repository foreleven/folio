import { Effect, FileSystem, Schema } from 'effect'
import { join } from 'node:path'
import { GitObjectId, GitSelectedPath } from '../../../shared/git-change'

const Identity = Schema.String.check(Schema.makeFilter((value) => /^[a-zA-Z0-9_-]{1,128}$/.test(value)))

export const SaveOperationFile = Schema.Struct({
  version: Schema.Literal(1),
  id: Identity,
  taskId: Schema.NullOr(Identity),
  kind: Schema.Literals(['user', 'raws', 'wiki']),
  runIds: Schema.Array(Identity),
  parent: GitObjectId,
  tree: GitObjectId,
  paths: Schema.NonEmptyArray(GitSelectedPath),
  commit: GitObjectId,
  beforeIndexTree: GitObjectId,
  afterIndexTree: GitObjectId,
  createdAt: Schema.Int
})
export type SaveOperationFile = typeof SaveOperationFile.Type

export const SyncOperationFile = Schema.Struct({
  version: Schema.Literal(1),
  id: Identity,
  taskId: Identity,
  sourceFrontier: GitObjectId,
  sourceHead: GitObjectId,
  sourceCommits: Schema.Array(GitObjectId),
  /** A Knowledge Task freezes one synthetic aggregate commit without advancing its branch. */
  aggregateCommit: Schema.NullOr(GitObjectId),
  mainBase: GitObjectId,
  conflictKind: Schema.NullOr(Schema.Literals(['source', 'resolution'])),
  conflictIndex: Schema.NullOr(Schema.Int),
  resolutionTree: Schema.NullOr(GitObjectId),
  alignmentHead: Schema.NullOr(GitObjectId),
  createdAt: Schema.Int
})
export type SyncOperationFile = typeof SyncOperationFile.Type

/** Paths are deterministic and stored relative to the Vault so a Vault can be moved safely. */
export function operationFilePath(root: string, id: string): { readonly relative: string; readonly directory: string; readonly absolute: string } {
  // Persist portable separators; Vaults may be moved between supported desktop platforms.
  const relative = `git-operations/${id}/operation.json`
  return { relative, directory: join(root, 'git-operations', id), absolute: join(root, relative) }
}

const writeFile = Effect.fn('GitOperationFiles.write')(function* (root: string, id: string, value: string) {
  const fs = yield* FileSystem.FileSystem
  const path = operationFilePath(root, id)
  yield* fs.makeDirectory(path.directory, { recursive: true })
  // The recovery checkpoint must be either the previous complete JSON document or the next one.
  // Writing beside the destination and renaming avoids exposing a truncated file after a crash.
  yield* Effect.scoped(Effect.gen(function* () {
    const temporary = yield* fs.makeTempFileScoped({ directory: path.directory, prefix: '.operation-' })
    yield* fs.writeFileString(temporary, value, { mode: 0o600 })
    yield* fs.rename(temporary, path.absolute)
  }))
  return path.relative
})

const readFile = Effect.fn('GitOperationFiles.read')(function* (root: string, relative: string) {
  const fs = yield* FileSystem.FileSystem
  const match = /^git-operations\/([a-zA-Z0-9_-]{1,128})\/operation\.json$/.exec(relative)
  if (!match) return yield* Effect.fail(new Error('Invalid Git operation artifact path'))
  return yield* fs.readFileString(join(root, 'git-operations', match[1]!, 'operation.json'))
})

/** Replaces one small JSON recovery checkpoint within its deterministic operation directory. */
export const writeSaveOperationFile = Effect.fn('GitOperationFiles.writeSave')(function* (root: string, value: SaveOperationFile) {
  const checked = yield* Schema.decodeUnknownEffect(SaveOperationFile)(value, { onExcessProperty: 'error' })
  return yield* writeFile(root, checked.id, `${JSON.stringify(checked, null, 2)}\n`)
})
export const readSaveOperationFile = Effect.fn('GitOperationFiles.readSave')(function* (root: string, relative: string) {
  return yield* readFile(root, relative).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(SaveOperationFile))))
})
export const writeSyncOperationFile = Effect.fn('GitOperationFiles.writeSync')(function* (root: string, value: SyncOperationFile) {
  const checked = yield* Schema.decodeUnknownEffect(SyncOperationFile)(value, { onExcessProperty: 'error' })
  return yield* writeFile(root, checked.id, `${JSON.stringify(checked, null, 2)}\n`)
})
export const readSyncOperationFile = Effect.fn('GitOperationFiles.readSync')(function* (root: string, relative: string) {
  return yield* readFile(root, relative).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(SyncOperationFile))))
})
