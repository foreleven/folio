import { Schema } from 'effect'

export const GitObjectId = Schema.String.check(Schema.makeFilter((value) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)))
export const GitSelectedPath = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (value) => !value.includes('\0') && !value.includes('\\') && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
  )
)
const Identity = Schema.String.check(Schema.makeFilter((value) => /^[a-zA-Z0-9_-]{1,128}$/.test(value)))

/** Frozen tree intent, supplied by the save coordinator rather than by a renderer path or diff. */
export const GitChangeIntent = Schema.Struct({
  id: Identity,
  taskId: Schema.NullOr(Identity),
  runIds: Schema.Array(Identity),
  kind: Schema.Literals(['user', 'raws', 'wiki']),
  parent: GitObjectId,
  tree: GitObjectId,
  paths: Schema.NonEmptyArray(GitSelectedPath)
})
export type GitChangeIntent = typeof GitChangeIntent.Type

/** Prepared means retained in Git, not applied to a branch or synchronized. */
export const GitChangePreparation = Schema.Struct({
  ...GitChangeIntent.fields,
  branch: Schema.NonEmptyString,
  commit: GitObjectId,
  createdAt: Schema.Int,
  state: Schema.Literals(['preparing', 'prepared'])
})
export type GitChangePreparation = typeof GitChangePreparation.Type

/** A source-branch save receipt is separate from preparation and from later synchronization. */
export const GitChangeApplication = Schema.Struct({
  id: Identity,
  branch: Schema.NonEmptyString,
  commit: GitObjectId,
  state: Schema.Literals(['applying', 'applied'])
})
export type GitChangeApplication = typeof GitChangeApplication.Type

export const GitSyncCanonicalCommit = Schema.Struct({
  sourceChangeId: Identity,
  sourceCommit: GitObjectId,
  tree: GitObjectId,
  commit: GitObjectId,
  data: Schema.String
})
export type GitSyncCanonicalCommit = typeof GitSyncCanonicalCommit.Type

/** Durable synchronization checkpoint; conflict retains its isolated coordinator worktree. */
export const GitSyncOperation = Schema.Struct({
  id: Identity,
  taskId: Identity,
  supersedesId: Schema.NullOr(Identity),
  sourceFrontier: GitObjectId,
  sourceHead: GitObjectId,
  sourceChanges: Schema.Array(Identity),
  sourceCommits: Schema.Array(GitObjectId),
  mainBase: GitObjectId,
  canonicalCommits: Schema.Array(GitSyncCanonicalCommit),
  conflictIndex: Schema.NullOr(Schema.Int),
  preparedHead: Schema.NullOr(GitObjectId),
  publishedHead: Schema.NullOr(GitObjectId),
  alignedHead: Schema.NullOr(GitObjectId),
  alignmentCommit: Schema.NullOr(GitObjectId),
  state: Schema.Literals(['preparing', 'conflict', 'resolving', 'prepared', 'published', 'aligning', 'aligned', 'superseded', 'aborted']),
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

export const PendingWorkspaceSave = Schema.Struct({ ...SaveWorkspaceFiles.fields, state: Schema.Literals(['preparing', 'prepared', 'applying']) })
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
