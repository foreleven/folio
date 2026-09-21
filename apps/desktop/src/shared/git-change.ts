import { Schema } from 'effect'

export const GitObjectId = Schema.String.check(Schema.makeFilter((value) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)))
export const GitSelectedPath = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (value) => !value.includes('\0') && !value.includes('\\') && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
  )
)
const Identity = Schema.String.check(Schema.makeFilter((value) => /^[a-zA-Z0-9_-]{1,128}$/.test(value)))

/** A save is one operation; Git stores its commit while SQLite stores only its lifecycle. */
export const GitChangeApplication = Schema.Struct({
  id: Identity,
  branch: Schema.NonEmptyString,
  commit: GitObjectId,
  state: Schema.Literals(['pending', 'completed'])
})
export type GitChangeApplication = typeof GitChangeApplication.Type

/** Compact synchronization receipt; detailed recovery state is a local operation artifact. */
export const GitSyncOperation = Schema.Struct({
  id: Identity,
  taskId: Identity,
  sourceHead: GitObjectId,
  publishedHead: Schema.NullOr(GitObjectId),
  state: Schema.Literals(['pending', 'conflict', 'prepared', 'published', 'completed', 'aborted']),
  createdAt: Schema.Int
})
export type GitSyncOperation = typeof GitSyncOperation.Type

/** Safe-to-display conflict evidence; coordinator filesystem paths stay inside the main process. */
export const GitConflictContext = Schema.Struct({
  files: Schema.Array(GitSelectedPath),
  commonBase: GitObjectId,
  canonicalDiff: Schema.String,
  taskDiff: Schema.String
})
export type GitConflictContext = typeof GitConflictContext.Type

export const SynchronizeTaskWiki = Schema.Struct({
  id: Identity,
  taskId: Identity,
  expectedSourceHead: GitObjectId
})
export type SynchronizeTaskWiki = typeof SynchronizeTaskWiki.Type

/** Replaces one stale prepared operation while retaining its frozen input and canonical receipt. */
export const ReprepareTaskWiki = Schema.Struct({
  id: Identity,
  taskId: Identity,
  supersededId: Identity
})
export type ReprepareTaskWiki = typeof ReprepareTaskWiki.Type

/** User save intent names files and an observed baseline, never a filesystem root or caller-built tree. */
export const SaveGitFiles = Schema.Struct({
  id: Identity,
  taskId: Schema.NullOr(Identity),
  expectedParent: GitObjectId,
  paths: Schema.NonEmptyArray(GitSelectedPath)
})
export type SaveGitFiles = typeof SaveGitFiles.Type

/** Public main-workspace save; Task saves use the separately scoped wiki intent below. */
export const SaveWorkspaceFiles = Schema.Struct({
  id: SaveGitFiles.fields.id,
  expectedParent: GitObjectId,
  paths: SaveGitFiles.fields.paths
})
export type SaveWorkspaceFiles = typeof SaveWorkspaceFiles.Type

/** Explicit Task save intent is limited to wiki files; Agent/raws capture has a separate lifecycle. */
export const SaveTaskWikiFiles = Schema.Struct({
  id: SaveGitFiles.fields.id,
  taskId: Identity,
  expectedParent: GitObjectId,
  paths: Schema.NonEmptyArray(GitSelectedPath.check(Schema.makeFilter((value) => value.startsWith('wiki/'))))
})
export type SaveTaskWikiFiles = typeof SaveTaskWikiFiles.Type

/** Host-owned Ingestion save; TaskService additionally checks the exact dated resource namespace. */
export const SaveTaskRawFiles = Schema.Struct({
  id: SaveGitFiles.fields.id,
  taskId: Identity,
  expectedParent: GitObjectId,
  paths: Schema.NonEmptyArray(GitSelectedPath.check(Schema.makeFilter((value) => value.startsWith('raws/'))))
})
export type SaveTaskRawFiles = typeof SaveTaskRawFiles.Type

/** Explicit user acceptance of selected wiki output attributed to one or more successful Runs. */
export const SaveRunWikiFiles = Schema.Struct({
  ...SaveTaskWikiFiles.fields,
  runIds: Schema.NonEmptyArray(Identity)
})
export type SaveRunWikiFiles = typeof SaveRunWikiFiles.Type

/** Explicit user confirmation that one successful Run left no wiki output to save. */
export const ConfirmRunWikiUnchanged = Schema.Struct({
  taskId: Identity,
  runId: Identity,
  expectedHead: GitObjectId
})
export type ConfirmRunWikiUnchanged = typeof ConfirmRunWikiUnchanged.Type

export const PendingWorkspaceSave = Schema.Struct({ ...SaveWorkspaceFiles.fields, state: Schema.Literal('pending') })
export const WorkspaceChangesView = Schema.Struct({
  head: GitObjectId,
  registered: Schema.Boolean,
  files: Schema.Array(Schema.Struct({ path: Schema.NonEmptyString, status: Schema.Literals(['added', 'modified', 'deleted']), selectable: Schema.Boolean })),
  pending: Schema.Array(PendingWorkspaceSave)
})
export type WorkspaceChangesView = typeof WorkspaceChangesView.Type
export const WorkspaceDiffInput = Schema.Struct({ expectedParent: GitObjectId, path: GitSelectedPath, saveId: Schema.NullOr(Identity) })
export type WorkspaceDiffInput = typeof WorkspaceDiffInput.Type
export const WorkspaceFileDiff = Schema.Struct({
  kind: Schema.Literals(['text', 'binary', 'too-large', 'unchanged']),
  text: Schema.String
})
export type WorkspaceFileDiff = typeof WorkspaceFileDiff.Type
