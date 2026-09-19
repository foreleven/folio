import { Context, DateTime, Effect, FileSystem, Layer, Schema } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { ChildProcessSpawner } from 'effect/unstable/process'
import { lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  GitObjectId,
  ReprepareTaskWiki,
  GitSelectedPath,
  GitConflictContext,
  GitSyncCanonicalCommit,
  GitSyncOperation,
  SynchronizeTaskWiki,
  type GitSyncOperation as GitSyncOperationValue
} from '../../../shared/git-change'
import { HarnessStoreError } from '../../../shared/harness'
import { gitCommitData, gitCommitHash } from '../git/git-commit-object'
import { isRegisteredGitCommit } from '../git/git-change-applications'
import { HarnessStore } from '../harness/harness-store'
import { makeVaultGit } from '../git/vault-git'
import { VaultGitWriteLock } from '../git/vault-git-write-lock'

const Row = Schema.Struct({
  sequence: Schema.Int,
  ...GitSyncOperation.fields,
  sourceChanges: Schema.fromJsonString(GitSyncOperation.fields.sourceChanges),
  sourceCommits: Schema.fromJsonString(GitSyncOperation.fields.sourceCommits),
  canonicalCommits: Schema.fromJsonString(GitSyncOperation.fields.canonicalCommits),
  alignmentData: Schema.NullOr(Schema.String)
})
type Row = typeof Row.Type
const ChangeRow = Schema.Struct({ id: Schema.String, commit: GitObjectId, paths: Schema.fromJsonString(Schema.Array(GitSelectedPath)) })
const ResolutionRow = Schema.Struct({
  operationId: Schema.String,
  conflictIndex: Schema.Int,
  sourceCommit: GitObjectId,
  parentCommit: GitObjectId,
  operationMainBase: GitObjectId,
  operationCanonicalCommits: Schema.fromJsonString(Schema.Array(GitSyncCanonicalCommit)),
  tree: GitObjectId,
  patch: Schema.String,
  createdAt: Schema.Int
})
const invalid = () => new HarnessStoreError({ reason: 'invalid-state', message: 'Task synchronization changed or requires inspection. No checkout was overwritten.' })
const storage = (cause: unknown) =>
  cause instanceof HarnessStoreError ? cause : new HarnessStoreError({ reason: 'storage', message: 'Task synchronization could not finish. Its checkpoints were retained.' })
export interface GitConflictResolutionContext extends GitConflictContext {
  readonly directory: string
  readonly files: readonly string[]
  readonly commonBase: string
  readonly canonicalDiff: string
  readonly taskDiff: string
}

/** Synchronizes manually saved wiki commits; Agent writer ownership and raws remain outside this service. */
export class TaskGitSynchronization extends Context.Service<
  TaskGitSynchronization,
  {
    readonly prepare: (input: SynchronizeTaskWiki) => Effect.Effect<GitSyncOperationValue, HarnessStoreError>
    readonly publish: (id: string) => Effect.Effect<GitSyncOperationValue, HarnessStoreError>
    readonly align: (id: string) => Effect.Effect<GitSyncOperationValue, HarnessStoreError>
    readonly synchronize: (input: SynchronizeTaskWiki) => Effect.Effect<GitSyncOperationValue, HarnessStoreError>
    readonly reprepare: (input: ReprepareTaskWiki) => Effect.Effect<GitSyncOperationValue, HarnessStoreError>
    readonly resolve: (id: string) => Effect.Effect<GitSyncOperationValue, HarnessStoreError>
    /** Resolves the persisted coordinator target without accepting any file or Git change. */
    readonly resolutionDirectory: (taskId: string, id: string) => Effect.Effect<string, HarnessStoreError>
    /** Supplies immutable conflict evidence for a Folio-authored resolution Prompt. */
    readonly resolutionContext: (taskId: string, id: string) => Effect.Effect<GitConflictResolutionContext, HarnessStoreError>
    /** Stages an ended Agent Run's wiki-only result, then continues canonical publish/alignment. */
    readonly acceptAgentResolution: (taskId: string, id: string, runId: string) => Effect.Effect<GitSyncOperationValue, HarnessStoreError>
    readonly abort: (id: string) => Effect.Effect<GitSyncOperationValue, HarnessStoreError>
    readonly get: (id: string) => Effect.Effect<GitSyncOperationValue, HarnessStoreError>
    readonly pending: Effect.Effect<readonly GitSyncOperationValue[], HarnessStoreError>
  }
>()('folio/services/TaskGitSynchronization') {
  static layer(directory: string) {
    return Layer.effect(
      TaskGitSynchronization,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const sql = yield* SqlClient.SqlClient
        const store = yield* HarnessStore
        const lock = yield* VaultGitWriteLock
        const git = yield* makeVaultGit
        const dependencies = yield* Effect.context<FileSystem.FileSystem | SqlClient.SqlClient | ChildProcessSpawner.ChildProcessSpawner>()
        const root = yield* fs.realPath(directory)
        const main = join(root, 'workspace')
        const coordinatorParent = join(root, 'sync-worktrees')

        /** Detached or missing symbolic HEAD is an identity mismatch, not a storage diagnostic. */
        const symbolicHead = (path: string) =>
          git(path, ['symbolic-ref', 'HEAD']).pipe(
            Effect.map((value) => value.trim()),
            Effect.catch(() => Effect.succeed(''))
          )

        /** Reads the full immutable input and mutable checkpoints; JSON columns are decoded at the SQL boundary. */
        const find = Effect.fn('TaskGitSynchronization.find')(function* (id: string) {
          yield* Schema.decodeUnknownEffect(SynchronizeTaskWiki.fields.id)(id)
          const rows = yield* sql`SELECT sequence, id, task_id AS taskId, supersedes_id AS supersedesId, source_frontier AS sourceFrontier,
          source_head AS sourceHead, source_changes AS sourceChanges, source_commits AS sourceCommits,
          main_base AS mainBase, canonical_commits AS canonicalCommits, conflict_index AS conflictIndex, prepared_head AS preparedHead,
          published_head AS publishedHead, aligned_head AS alignedHead, alignment_commit AS alignmentCommit,
          alignment_data AS alignmentData, state, created_at AS createdAt
          FROM git_sync_operations WHERE id=${id}`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Row))))
          return rows[0]
        })

        /** Verifies both owned checkouts without repairing refs, indexes, work files or interrupted Git commands. */
        const checkouts = Effect.fn('TaskGitSynchronization.checkouts')(function* (taskId: string) {
          const task = yield* store.task(taskId)
          const taskPath = join(root, 'worktrees', taskId)
          if (task.state !== 'active' || task.worktreeState !== 'ready' || task.worktree !== taskPath || task.branch !== `folio/task/${taskId}` || !task.worktreeBase)
            return yield* invalid()
          if (
            (yield* fs.realPath(main)) !== main ||
            (yield* fs.realPath(join(main, '.git'))) !== join(main, '.git') ||
            (yield* fs.realPath(taskPath)) !== taskPath ||
            (yield* git(main, ['rev-parse', '--show-toplevel'])).trim() !== main ||
            (yield* symbolicHead(main)) !== 'refs/heads/main' ||
            (yield* git(taskPath, ['rev-parse', '--show-toplevel'])).trim() !== taskPath ||
            (yield* symbolicHead(taskPath)) !== `refs/heads/${task.branch}` ||
            (yield* fs.realPath(resolve(taskPath, (yield* git(taskPath, ['rev-parse', '--git-common-dir'])).trim()))) !== join(main, '.git')
          ) {
            return yield* invalid()
          }
          for (const path of [main, taskPath]) {
            const gitDirectory = (yield* git(path, ['rev-parse', '--absolute-git-dir'])).trim()
            for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
              if (yield* fs.exists(join(gitDirectory, name))) return yield* invalid()
            }
          }
          if ((yield* sql`SELECT id FROM runs WHERE task_id=${taskId} AND state IN ('preparing', 'running')`).length) {
            return yield* new HarnessStoreError({ reason: 'task-busy', message: 'Task has an active Run.' })
          }
          if (
            (yield* sql`SELECT a.id FROM git_change_applications a JOIN git_change_preparations p ON p.id=a.id
          WHERE p.task_id=${taskId} AND a.state='applying'`).length
          )
            return yield* invalid()
          return { task, taskPath }
        })

        /** Reads the repository object format so generated commit/ref bytes use the active hash algorithm. */
        const objectFormat = Effect.fn('TaskGitSynchronization.objectFormat')(function* () {
          return yield* Schema.decodeUnknownEffect(Schema.Literals(['sha1', 'sha256']))((yield* git(main, ['rev-parse', '--show-object-format'])).trim())
        })

        /** Creates a direct protected ref with compare-and-swap; matching concurrent recovery is idempotent. */
        const retainRef = Effect.fn('TaskGitSynchronization.retainRef')(function* (ref: string, commit: string) {
          const expected = `${ref} ${commit}`
          const read = git(main, ['for-each-ref', '--format=%(refname) %(objectname) %(symref)', ref]).pipe(Effect.map((value) => value.trim()))
          const current = yield* read
          if (current === expected) return
          if (current) return yield* invalid()
          yield* git(main, ['update-ref', '--no-deref', ref, commit, '0'.repeat(commit.length)]).pipe(
            Effect.asVoid,
            Effect.catch((error) => read.pipe(Effect.flatMap((actual) => (actual === expected ? Effect.void : actual ? Effect.fail(invalid()) : Effect.fail(storage(error))))))
          )
          if ((yield* read) !== expected) return yield* invalid()
        })

        /** Restores every accepted prefix object/ref without requiring a final prepared receipt. */
        const retainCanonicalPrefix = Effect.fn('TaskGitSynchronization.retainCanonicalPrefix')(function* (row: Row) {
          for (const [index, item] of row.canonicalCommits.entries()) {
            if (
              (yield* git(main, ['hash-object', '-t', 'commit', '-w', '--stdin'], { input: item.data })).trim() !== item.commit ||
              (yield* git(main, ['cat-file', 'commit', item.commit])) !== item.data
            )
              return yield* invalid()
            yield* retainRef(`refs/folio/sync/${row.id}/steps/${index}`, item.commit)
          }
        })

        /** Writes exact journaled bytes and refuses a same-ID protected ref that points elsewhere. */
        const retain = Effect.fn('TaskGitSynchronization.retain')(function* (row: Row) {
          yield* retainCanonicalPrefix(row)
          const head = row.preparedHead
          if (!head) return yield* invalid()
          yield* retainRef(`refs/folio/sync/${row.id}/canonical`, head)
        })

        /** Restores exact alignment bytes and verifies its direct protected ref before any receipt. */
        const retainAlignment = Effect.fn('TaskGitSynchronization.retainAlignment')(function* (row: Row) {
          const commit = row.alignmentCommit
          const data = row.alignmentData
          if (
            !commit ||
            !data ||
            (yield* git(main, ['hash-object', '-t', 'commit', '-w', '--stdin'], { input: data })).trim() !== commit ||
            (yield* git(main, ['cat-file', 'commit', commit])) !== data
          )
            return yield* invalid()
          yield* retainRef(`refs/folio/sync/${row.id}/alignment`, commit)
          return commit
        })

        /** Freezes the complete registered suffix. Alignment commits are frontiers and never exported back to main. */
        const reserve = Effect.fn('TaskGitSynchronization.reserve')(function* (input: SynchronizeTaskWiki, supersedesId: string | null = null) {
          const value = yield* Schema.decodeUnknownEffect(SynchronizeTaskWiki)(input, { onExcessProperty: 'error' })
          const prior = yield* find(value.id)
          if (prior) {
            if (prior.taskId !== value.taskId || prior.sourceHead !== value.expectedSourceHead) return yield* invalid()
            return prior
          }
          const { task, taskPath } = yield* checkouts(value.taskId)
          const sourceHead = (yield* git(taskPath, ['rev-parse', 'HEAD'])).trim()
          if (sourceHead !== value.expectedSourceHead) return yield* invalid()
          const priorOperations = yield* sql<{ sourceHead: string; alignedHead: string | null; publishedHead: string | null; state: string }>`SELECT
          source_head AS sourceHead, aligned_head AS alignedHead, published_head AS publishedHead, state FROM git_sync_operations
          WHERE task_id=${value.taskId} AND state IN ('published', 'aligning', 'aligned') ORDER BY sequence DESC LIMIT 1`
          const priorOperation = priorOperations[0]
          if (priorOperation?.state === 'aligning') return yield* invalid()
          // A reopened Task starts from a new worktree_base at current main. In that case the
          // historical aligned frontier is intentionally retained for audit, but must not be
          // traversed again: intervening main commits have no Task source journal entries.
          // Detect the new generation by checking that the persisted base is at/after the prior
          // published main head; ordinary rounds keep the original base behind that head.
          const reopenedGeneration = priorOperation?.state === 'aligned' && task.worktreeBase &&
            priorOperation.publishedHead &&
            (yield* git(taskPath, ['merge-base', '--is-ancestor', priorOperation.publishedHead, task.worktreeBase]).pipe(
              Effect.as(true),
              Effect.catch(() => Effect.succeed(false))
            ))
          const sourceFrontier = reopenedGeneration
            ? task.worktreeBase!
            : priorOperation
              ? (priorOperation.state === 'aligned' ? priorOperation.alignedHead! : priorOperation.sourceHead)
              : task.worktreeBase!
          yield* git(taskPath, ['merge-base', '--is-ancestor', sourceFrontier, sourceHead]).pipe(Effect.mapError(invalid))
          const listed = (yield* git(taskPath, ['rev-list', '--reverse', '--first-parent', `${sourceFrontier}..${sourceHead}`])).trim()
          const sourceCommits = listed ? listed.split('\n') : []
          const sourceChanges: string[] = []
          let parent = sourceFrontier
          for (const commit of sourceCommits) {
            const ancestry = (yield* git(taskPath, ['rev-list', '--parents', '-n', '1', commit])).trim().split(' ')
            if (ancestry.length !== 2 || ancestry[1] !== parent) return yield* invalid()
            const rows = yield* sql`SELECT p.id, p.commit_oid AS "commit", p.paths FROM git_change_preparations p
            JOIN git_change_applications a ON a.id=p.id
            WHERE p.task_id=${value.taskId} AND p.branch=${task.branch} AND p.kind IN ('user', 'wiki')
              AND p.commit_oid=${commit} AND a.state='applied'`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ChangeRow))))
            if (rows.length !== 1 || rows[0]!.paths.some((path) => !path.startsWith('wiki/'))) return yield* invalid()
            sourceChanges.push(rows[0]!.id)
            parent = commit
          }
          const marker = yield* fs
            .readFileString(join(main, '.git/folio-workspace.json'))
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ version: Schema.Literal(1), initialCommit: GitObjectId })))))
          const mainBase = (yield* git(main, ['rev-parse', 'HEAD'])).trim()
          if (!(yield* isRegisteredGitCommit('main', mainBase, marker.initialCommit))) return yield* invalid()
          const createdAt = DateTime.toEpochMillis(yield* DateTime.now)
          yield* sql`INSERT INTO git_sync_operations
          (id, task_id, supersedes_id, source_frontier, source_head, source_changes, source_commits, main_base, created_at, state)
          VALUES (${value.id}, ${value.taskId}, ${supersedesId}, ${sourceFrontier}, ${sourceHead}, ${JSON.stringify(sourceChanges)},
            ${JSON.stringify(sourceCommits)}, ${mainBase}, ${createdAt}, 'preparing')`
          return (yield* find(value.id))!
        })

        /** Builds and retains one deterministic canonical commit before advancing coordinator HEAD. */
        const appendCanonical = Effect.fn('TaskGitSynchronization.appendCanonical')(function* (row: Row, index: number, tree: string) {
          if (index > row.canonicalCommits.length || index >= row.sourceCommits.length) return yield* invalid()
          const sourceChangeId = row.sourceChanges[index]!
          const sourceCommit = row.sourceCommits[index]!
          const parent = index === 0 ? row.mainBase : row.canonicalCommits[index - 1]!.commit
          const data = gitCommitData({
            tree,
            parent,
            createdAt: row.createdAt + index * 1000,
            message: `Synchronize wiki change\n\nFolio-Sync-Operation: ${row.id}\nFolio-Source-Change: ${sourceChangeId}\nFolio-Source-Commit: ${sourceCommit}\nFolio-Task-Id: ${row.taskId}\n`
          })
          const item: typeof GitSyncCanonicalCommit.Type = { sourceChangeId, sourceCommit, tree, commit: gitCommitHash(data, yield* objectFormat()), data }
          const previous = row.canonicalCommits[index]
          if (previous && JSON.stringify(previous) !== JSON.stringify(item)) return yield* invalid()
          if (
            (yield* git(main, ['hash-object', '-t', 'commit', '-w', '--stdin'], { input: data })).trim() !== item.commit ||
            (yield* git(main, ['cat-file', 'commit', item.commit])) !== data
          )
            return yield* invalid()
          yield* retainRef(`refs/folio/sync/${row.id}/steps/${index}`, item.commit)
          if (previous) return row
          const canonicalCommits = [...row.canonicalCommits, item]
          const changed = row.state === 'conflict'
            ? yield* sql`UPDATE git_sync_operations SET canonical_commits=${JSON.stringify(canonicalCommits)}, state='resolving'
              WHERE id=${row.id} AND state='conflict' AND conflict_index=${index}
                AND canonical_commits=${JSON.stringify(row.canonicalCommits)} RETURNING id`
            : yield* sql`UPDATE git_sync_operations SET canonical_commits=${JSON.stringify(canonicalCommits)}
              WHERE id=${row.id} AND state IN ('preparing', 'resolving')
                AND canonical_commits=${JSON.stringify(row.canonicalCommits)} RETURNING id`
          if (!changed.length) return yield* invalid()
          return (yield* find(row.id))!
        })

        /** Checks that an existing coordinator is the detached worktree owned by this operation. */
        const coordinatorCheckout = Effect.fn('TaskGitSynchronization.coordinatorCheckout')(function* (row: Row) {
          const coordinator = join(coordinatorParent, row.id)
          if (!(yield* fs.exists(coordinator)) || !(yield* fs.exists(join(coordinator, '.git')))) return yield* invalid()
          const info = yield* Effect.tryPromise(() => lstat(join(coordinator, '.git')))
          if (
            !info.isFile() || info.isSymbolicLink() ||
            (yield* fs.realPath(coordinator)) !== coordinator ||
            (yield* git(coordinator, ['rev-parse', '--show-toplevel'])).trim() !== coordinator ||
            (yield* fs.realPath(resolve(coordinator, (yield* git(coordinator, ['rev-parse', '--git-common-dir'])).trim()))) !== join(main, '.git') ||
            (yield* symbolicHead(coordinator)) !== ''
          )
            return yield* invalid()
          const knownHeads = new Set([row.mainBase, ...row.canonicalCommits.map((item) => item.commit)])
          if (!knownHeads.has((yield* git(coordinator, ['rev-parse', 'HEAD'])).trim())) return yield* invalid()
          return coordinator
        })

        /**
         * Restores only an authenticated, detached coordinator to a journaled commit.
         *
         * Coordinators are Folio-owned scratch checkouts, but they can be edited by an
         * Agent between checkpoints.  Refuse to discard an unexpected untracked file and
         * restore the index/worktree explicitly before moving the detached HEAD.  This keeps
         * the destructive boundary narrow and never permits this helper to target main or a
         * Task worktree.
         */
        const restoreCoordinator = Effect.fn('TaskGitSynchronization.restoreCoordinator')(function* (row: Row, coordinator: string, commit: string) {
          if ((yield* coordinatorCheckout(row)) !== coordinator) return yield* invalid()
          if ((yield* git(coordinator, ['cat-file', '-t', commit])).trim() !== 'commit') return yield* invalid()
          const untracked = (yield* git(coordinator, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
          if (untracked.length) return yield* invalid()
          yield* git(coordinator, ['restore', '--source', commit, '--staged', '--worktree', '--', '.'])
          // `restore` intentionally leaves HEAD untouched; update only the detached HEAD
          // after the exact tree/index has been restored.
          yield* git(coordinator, ['update-ref', 'HEAD', commit])
          if ((yield* git(coordinator, ['rev-parse', 'HEAD'])).trim() !== commit) return yield* invalid()
        })

        /** Requires the exact interrupted cherry-pick before exposing a coordinator to an Agent. */
        const conflictCheckout = Effect.fn('TaskGitSynchronization.conflictCheckout')(function* (taskId: string, id: string) {
          const row = yield* find(id)
          if (!row || row.taskId !== taskId)
            return yield* new HarnessStoreError({ reason: 'not-found', message: 'Synchronization was not found.' })
          if (row.state !== 'conflict' || row.conflictIndex === null) return yield* invalid()
          const coordinator = yield* coordinatorCheckout(row)
          const expectedHead = row.canonicalCommits.at(-1)?.commit ?? row.mainBase
          const sourceCommit = row.sourceCommits[row.conflictIndex]
          const gitDirectory = (yield* git(coordinator, ['rev-parse', '--absolute-git-dir'])).trim()
          if (!sourceCommit ||
            (yield* git(coordinator, ['rev-parse', 'HEAD'])).trim() !== expectedHead ||
            ((yield* fs.exists(join(gitDirectory, 'CHERRY_PICK_HEAD'))) &&
              (yield* git(coordinator, ['rev-parse', 'CHERRY_PICK_HEAD'])).trim() !== sourceCommit)) {
            return yield* invalid()
          }
          return { row, coordinator, sourceCommit }
        })

        /** Verifies a conflict checkout contains only a completely staged wiki resolution. */
        const stagedResolution = Effect.fn('TaskGitSynchronization.stagedResolution')(function* (row: Row, coordinator: string) {
          if ((yield* git(coordinator, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean).length)
            return yield* invalid()
          if ((yield* git(coordinator, ['diff', '--name-only', '-z'])).split('\0').filter(Boolean).length)
            return yield* invalid()
          if ((yield* git(coordinator, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean).length)
            return yield* invalid()
          const staged = (yield* git(coordinator, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean)
          if (staged.some((path) => !path.startsWith('wiki/'))) return yield* invalid()
          if (staged.length) {
            const entries = (yield* git(coordinator, ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', ...staged])).split('\0').filter(Boolean)
            if (entries.some((entry) => !entry.startsWith('100644 ') || !entry.includes('\t'))) return yield* invalid()
          }
          const parentCommit = row.canonicalCommits.at(-1)?.commit ?? row.mainBase
          const tree = (yield* git(coordinator, ['write-tree'])).trim()
          return { parentCommit, tree, staged }
        })

        /** Persists the exact staged resolution before checking whether the old main is still current. */
        const captureResolutionInput = Effect.fn('TaskGitSynchronization.captureResolutionInput')(function* (row: Row) {
          if (row.state !== 'conflict' || row.conflictIndex === null) return null
          const { coordinator, sourceCommit } = yield* conflictCheckout(row.taskId, row.id)
          const { parentCommit, tree } = yield* stagedResolution(row, coordinator)
          const patch = yield* git(coordinator, ['diff', '--binary', parentCommit, tree, '--', 'wiki'])
          if (Buffer.byteLength(patch) > 512 * 1024) return yield* invalid()
          const rows = yield* sql`SELECT operation_id AS operationId, conflict_index AS conflictIndex,
            source_commit AS sourceCommit, parent_commit AS parentCommit,
            (SELECT main_base FROM git_sync_operations WHERE id=${row.id}) AS operationMainBase,
            (SELECT canonical_commits FROM git_sync_operations WHERE id=${row.id}) AS operationCanonicalCommits,
            tree, patch, created_at AS createdAt
            FROM git_sync_resolution_inputs WHERE operation_id=${row.id} AND conflict_index=${row.conflictIndex}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ResolutionRow)))
          )
          const existing = rows[0]
          if (existing) {
            if (existing.sourceCommit !== sourceCommit || existing.parentCommit !== parentCommit || existing.tree !== tree || existing.patch !== patch)
              return yield* invalid()
            yield* retainRef(`refs/folio/sync/${row.id}/resolution/${row.conflictIndex}`, existing.tree)
            return existing
          }
          const createdAt = DateTime.toEpochMillis(yield* DateTime.now)
          yield* sql`INSERT INTO git_sync_resolution_inputs
            (operation_id, conflict_index, source_commit, parent_commit, tree, patch, created_at)
            VALUES (${row.id}, ${row.conflictIndex}, ${sourceCommit}, ${parentCommit}, ${tree}, ${patch}, ${createdAt})`
          // Keep the accepted tree reachable after the coordinator is eventually removed; the
          // patch alone is not sufficient evidence for a deterministic replay after GC.
          yield* retainRef(`refs/folio/sync/${row.id}/resolution/${row.conflictIndex}`, tree)
          return {
            operationId: row.id,
            conflictIndex: row.conflictIndex,
            sourceCommit,
            parentCommit,
            operationMainBase: row.mainBase,
            operationCanonicalCommits: row.canonicalCommits,
            tree,
            patch,
            createdAt
          }
        })

        /** Reads an immutable replay patch for a source conflict, if one was accepted previously. */
        const resolutionInput = Effect.fn('TaskGitSynchronization.resolutionInput')(function* (operationId: string, index: number) {
          const rows = yield* sql`WITH RECURSIVE lineage(operationId, depth) AS (
              SELECT id, 0 FROM git_sync_operations WHERE id=${operationId}
              UNION ALL
              SELECT operation.supersedes_id, lineage.depth + 1
              FROM git_sync_operations operation JOIN lineage ON operation.id=lineage.operationId
              WHERE operation.supersedes_id IS NOT NULL
            )
            SELECT input.operation_id AS operationId, input.conflict_index AS conflictIndex,
              input.source_commit AS sourceCommit, input.parent_commit AS parentCommit,
              operation.main_base AS operationMainBase, operation.canonical_commits AS operationCanonicalCommits,
              input.tree, input.patch, input.created_at AS createdAt
            FROM lineage JOIN git_sync_resolution_inputs input ON input.operation_id=lineage.operationId
              JOIN git_sync_operations operation ON operation.id=input.operation_id
            WHERE input.conflict_index=${index} ORDER BY lineage.depth LIMIT 1`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ResolutionRow)))
          )
          return rows[0] ?? null
        })

        /** Builds both sides from the frozen cherry-pick parent; files themselves remain available in cwd. */
        const resolutionContextLocked = Effect.fn('TaskGitSynchronization.resolutionContextLocked')(function* (taskId: string, id: string) {
          const { coordinator, sourceCommit } = yield* conflictCheckout(taskId, id)
          const files = (yield* git(coordinator, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean)
          if (!files.length || files.some((path) => !path.startsWith('wiki/'))) return yield* invalid()
          const commonBase = (yield* git(coordinator, ['rev-parse', `${sourceCommit}^`])).trim()
          // Git-reported names are literal files, never patterns selecting additional evidence.
          const canonicalDiff = yield* git(coordinator, ['--literal-pathspecs', 'diff', '--no-ext-diff', '--binary', commonBase, 'HEAD', '--', ...files])
          const taskDiff = yield* git(coordinator, ['--literal-pathspecs', 'diff', '--no-ext-diff', '--binary', commonBase, sourceCommit, '--', ...files])
          // Refuse an unbounded Prompt rather than silently dropping one side of the conflict.
          if (Buffer.byteLength(canonicalDiff) + Buffer.byteLength(taskDiff) > 512 * 1024) return yield* invalid()
          return { directory: coordinator, files, commonBase, canonicalDiff, taskDiff }
        })

        /** Removes scratch only after proving the path is still this operation's registered worktree. */
        const removeCoordinator = Effect.fn('TaskGitSynchronization.removeCoordinator')(function* (row: Row) {
          const coordinator = join(coordinatorParent, row.id)
          if (!(yield* fs.exists(coordinator))) return
          yield* coordinatorCheckout(row)
          yield* git(main, ['worktree', 'remove', '--force', coordinator])
        })

        /** Appends remaining source commits, retaining every prefix so a later conflict is restart-safe. */
        const continuePreparation = Effect.fn('TaskGitSynchronization.continuePreparation')(function* (input: Row, coordinator: string) {
          let row = input
          for (let index = row.canonicalCommits.length; index < row.sourceCommits.length; index += 1) {
            const sourceCommit = row.sourceCommits[index]!
            // A previously accepted resolution is replayed as a three-way patch. This is the
            // durable bridge for a coordinator whose original main became stale before receipt.
            const replay = yield* resolutionInput(row.id, index)
            let applied: boolean
            if (replay) {
              // Resolution inputs are immutable evidence, but still validate them at the
              // filesystem boundary: a corrupt row must not redirect replay outside wiki/**.
              // The captured parent belongs to the superseded operation's canonical prefix;
              // comparing it with the replacement's current prefix would reject valid replay
              // after the replacement has already accepted an earlier resolution.
              if (replay.sourceCommit !== sourceCommit)
                return yield* invalid()
              if ((yield* git(coordinator, ['cat-file', '-t', replay.parentCommit])).trim() !== 'commit')
                return yield* invalid()
              if ((yield* git(coordinator, ['cat-file', '-t', replay.tree])).trim() !== 'tree')
                return yield* invalid()
              const expectedPatch = yield* git(coordinator, ['diff', '--binary', replay.parentCommit, replay.tree, '--', 'wiki'])
              if (expectedPatch !== replay.patch) return yield* invalid()
              applied = replay.patch === ''
                ? true
                : yield* git(coordinator, ['apply', '--3way', '--index'], { input: replay.patch }).pipe(
                    Effect.as(true),
                    Effect.catch(() => Effect.succeed(false))
                  )
              if (applied) {
                const stagedPaths = (yield* git(coordinator, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean)
                if (stagedPaths.some((path) => !path.startsWith('wiki/'))) return yield* invalid()
              }
            } else {
              applied = yield* git(coordinator, ['cherry-pick', '--no-commit', sourceCommit]).pipe(
                Effect.as(true),
                Effect.catch(() => Effect.succeed(false))
              )
            }
            if (!applied) {
              const conflicts = (yield* git(coordinator, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean)
              if (!conflicts.length || conflicts.some((path) => !path.startsWith('wiki/'))) return yield* invalid()
              const changed = yield* sql`UPDATE git_sync_operations SET state='conflict', conflict_index=${index}
                WHERE id=${row.id} AND state IN ('preparing', 'resolving')
                  AND canonical_commits=${JSON.stringify(row.canonicalCommits)} RETURNING id`
              if (!changed.length) return yield* invalid()
              return (yield* find(row.id))!
            }
            const tree = (yield* git(coordinator, ['write-tree'])).trim()
            row = yield* appendCanonical(row, index, tree)
            // This is isolated scratch. The accepted tree is already journaled and retained before
            // the authenticated restore makes it the clean parent for the next source commit.
            yield* restoreCoordinator(row, coordinator, row.canonicalCommits[index]!.commit)
          }
          const preparedHead = row.canonicalCommits.at(-1)?.commit ?? row.mainBase
          const checkpoint = yield* sql`UPDATE git_sync_operations SET prepared_head=${preparedHead}
            WHERE id=${row.id} AND state IN ('preparing', 'resolving')
              AND prepared_head IS NULL AND canonical_commits=${JSON.stringify(row.canonicalCommits)} RETURNING id`
          if (!checkpoint.length) return yield* invalid()
          row = (yield* find(row.id))!
          yield* retain(row)
          const completed = yield* sql`UPDATE git_sync_operations SET conflict_index=NULL, state='prepared'
            WHERE id=${row.id} AND state IN ('preparing', 'resolving') AND prepared_head=${preparedHead} RETURNING id`
          if (!completed.length) return yield* invalid()
          row = (yield* find(row.id))!
          yield* removeCoordinator(row)
          return row
        })

        /** Creates canonical trees in an isolated worktree; unresolved conflict state is retained. */
        const prepareLocked = Effect.fn('TaskGitSynchronization.prepareLocked')(function* (input: SynchronizeTaskWiki) {
          let row = yield* reserve(input)
          const coordinator = join(coordinatorParent, row.id)
          if (row.state !== 'preparing') {
            // Only conflict/resolving coordinators carry accepted external work. Prepared scratch
            // may survive a lost cleanup receipt and is safe to discard after object verification.
            if (row.state === 'prepared') yield* removeCoordinator(row)
            return row
          }
          if (row.preparedHead) {
            yield* removeCoordinator(row)
            yield* retain(row)
            yield* sql`UPDATE git_sync_operations SET state='prepared' WHERE id=${row.id} AND state='preparing'`
            row = (yield* find(row.id))!
            return row
          }
          const { taskPath } = yield* checkouts(row.taskId)
          if ((yield* git(taskPath, ['rev-parse', 'HEAD'])).trim() !== row.sourceHead) return yield* invalid()
          yield* fs.makeDirectory(coordinatorParent, { recursive: true })
          if ((yield* fs.realPath(coordinatorParent)) !== coordinatorParent) return yield* invalid()
          if (yield* fs.exists(coordinator)) {
            // Preparing has never accepted resolver edits. Rebuild only from journaled inputs.
            yield* removeCoordinator(row)
          }
          for (const [index, item] of row.canonicalCommits.entries()) row = yield* appendCanonical(row, index, item.tree)
          yield* git(main, ['worktree', 'prune'])
          yield* git(main, ['worktree', 'add', '--detach', coordinator, row.canonicalCommits.at(-1)?.commit ?? row.mainBase])
          return yield* continuePreparation(row, coordinator)
        })

        /** Accepts a fully staged wiki resolution, then resumes all remaining frozen commits. */
        const resolveLocked = Effect.fn('TaskGitSynchronization.resolveLocked')(function* (id: string) {
          let row = yield* find(id)
          if (!row) return yield* new HarnessStoreError({ reason: 'not-found', message: 'Synchronization was not found.' })
          if (['prepared', 'published', 'aligning', 'aligned'].includes(row.state)) return row
          if (row.state !== 'conflict' && row.state !== 'resolving') return yield* invalid()
          // Capture the staged result before the main-head gate. If main advanced, the caller can
          // reprepare from this immutable patch instead of losing the user's conflict resolution.
          if (row.state === 'conflict') yield* captureResolutionInput(row)
          if (row.state === 'resolving' && row.preparedHead) {
            yield* retain(row)
            const completed = yield* sql`UPDATE git_sync_operations SET conflict_index=NULL, state='prepared'
              WHERE id=${row.id} AND state='resolving' AND prepared_head=${row.preparedHead} RETURNING id`
            if (!completed.length) return yield* invalid()
            yield* removeCoordinator(row)
            return (yield* find(row.id))!
          }
          const { taskPath } = yield* checkouts(row.taskId)
          if (
            (yield* git(main, ['rev-parse', 'HEAD'])).trim() !== row.mainBase ||
            (yield* git(taskPath, ['rev-parse', 'HEAD'])).trim() !== row.sourceHead ||
            (yield* git(main, ['status', '--porcelain', '--untracked-files=all'])).trim() ||
            (yield* git(taskPath, ['status', '--porcelain', '--untracked-files=all'])).trim()
          )
            return yield* invalid()
          if (row.state === 'resolving' && !(yield* fs.exists(join(coordinatorParent, row.id)))) {
            const accepted = row.canonicalCommits.at(-1)
            if (!accepted) return yield* invalid()
            yield* fs.makeDirectory(coordinatorParent, { recursive: true })
            if ((yield* fs.realPath(coordinatorParent)) !== coordinatorParent) return yield* invalid()
            yield* retainRef(`refs/folio/sync/${row.id}/steps/${row.canonicalCommits.length - 1}`, accepted.commit)
            yield* git(main, ['worktree', 'prune'])
            yield* git(main, ['worktree', 'add', '--detach', join(coordinatorParent, row.id), accepted.commit])
          }
          const coordinator = yield* coordinatorCheckout(row)
          const gitDirectory = (yield* git(coordinator, ['rev-parse', '--absolute-git-dir'])).trim()
          let newlyAcceptedTree: string | null = null
          if (row.state === 'conflict') {
            const index = row.conflictIndex
            if (index === null || index !== row.canonicalCommits.length) return yield* invalid()
            newlyAcceptedTree = (yield* stagedResolution(row, coordinator)).tree
            row = yield* appendCanonical(row, index, newlyAcceptedTree)
          }
          const accepted = row.canonicalCommits.at(-1)
          if (!accepted) return yield* invalid()
          if (newlyAcceptedTree && (yield* git(coordinator, ['write-tree'])).trim() !== newlyAcceptedTree) return yield* invalid()
          if (yield* fs.exists(join(gitDirectory, 'CHERRY_PICK_HEAD'))) yield* git(coordinator, ['cherry-pick', '--quit'])
          // Once state is resolving, every accepted external edit is already represented by the
          // retained commit. Discard only an unjournaled service attempt left by a crash.
          yield* restoreCoordinator(row, coordinator, accepted.commit)
          return yield* continuePreparation(row, coordinator)
        })

        /** Agent execution is file-only: Folio owns the single index transition after process cleanup. */
        const acceptAgentResolutionLocked = Effect.fn('TaskGitSynchronization.acceptAgentResolutionLocked')(function* (taskId: string, id: string, runId: string) {
          let row = yield* find(id)
          if (!row || row.taskId !== taskId)
            return yield* new HarnessStoreError({ reason: 'not-found', message: 'Synchronization was not found.' })
          const acceptedRuns = yield* sql`SELECT run.id FROM runs run JOIN sessions session
            ON session.id=run.session_id AND session.task_id=run.task_id
            WHERE run.id=${runId} AND run.task_id=${taskId} AND run.purpose='conflict-resolution'
              AND run.state='succeeded' AND session.purpose='conflict-resolution'
              AND session.sync_operation_id=${id}`
          if (!acceptedRuns.length) return yield* invalid()
          // A terminal Run may have already accepted the coordinator and moved Git before its
          // publish/alignment receipt was persisted. Keep retrying prepared/published/aligning;
          // only aligned is terminal for this post-processing hook.
          if (row.state === 'aligned') return row
          if (!['conflict', 'resolving', 'prepared', 'published', 'aligning'].includes(row.state)) return yield* invalid()
          if (row.state === 'conflict') {
            const { coordinator } = yield* conflictCheckout(taskId, id)
            yield* checkouts(taskId)
            const unmerged = (yield* git(coordinator, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean)
            // A missing unmerged index means the Agent performed a prohibited Git index write.
            if (!unmerged.length || unmerged.some((path) => !path.startsWith('wiki/'))) return yield* invalid()
            const paths = new Set<string>()
            for (const args of [
              ['diff', '--name-only', '-z'],
              ['diff', '--cached', '--name-only', '-z'],
              ['ls-files', '--others', '--exclude-standard', '-z']
            ] as const) {
              for (const path of (yield* git(coordinator, args)).split('\0').filter(Boolean)) paths.add(path)
            }
            if ([...paths].some((path) => !path.startsWith('wiki/'))) return yield* invalid()
            yield* git(coordinator, ['add', '-A', '--', 'wiki'])
          }
          row = yield* resolveLocked(id)
          if (row.state === 'conflict') return row
          row = yield* publishLocked(row.id)
          return yield* alignLocked(row.id)
        })

        /** Explicitly discards only the isolated coordinator; source/main history remains untouched. */
        const abortLocked = Effect.fn('TaskGitSynchronization.abortLocked')(function* (id: string) {
          const row = yield* find(id)
          if (!row) return yield* new HarnessStoreError({ reason: 'not-found', message: 'Synchronization was not found.' })
          if (row.state === 'aborted') return row
          if (row.state !== 'conflict' && row.state !== 'resolving') return yield* invalid()
          yield* checkouts(row.taskId)
          yield* removeCoordinator(row)
          const changed = yield* sql`UPDATE git_sync_operations SET state='aborted' WHERE id=${row.id}
            AND state IN ('conflict', 'resolving') RETURNING id`
          if (!changed.length) return yield* invalid()
          return (yield* find(row.id))!
        })

        /** Atomically retires a stale preparation and registers its exact source against current main. */
        const reprepareLocked = Effect.fn('TaskGitSynchronization.reprepareLocked')(function* (input: ReprepareTaskWiki) {
          const value = yield* Schema.decodeUnknownEffect(ReprepareTaskWiki)(input, { onExcessProperty: 'error' })
          if (value.id === value.supersededId) return yield* invalid()
          const ownedPrevious = yield* find(value.supersededId)
          if (!ownedPrevious || ownedPrevious.taskId !== value.taskId)
            return yield* new HarnessStoreError({ reason: 'not-found', message: 'Synchronization was not found.' })
          // A staged conflict result must be journaled before the old operation can be retired.
          // This remains safe when main has already advanced because it only reads the isolated
          // coordinator and inserts an immutable resolution input.
          if (ownedPrevious.state === 'conflict') yield* captureResolutionInput(ownedPrevious)
          const replacement = yield* find(value.id)
          if (replacement) {
            if (
              ownedPrevious.state !== 'superseded' ||
              replacement.supersedesId !== ownedPrevious.id ||
              replacement.taskId !== value.taskId ||
              replacement.sourceFrontier !== ownedPrevious.sourceFrontier ||
              replacement.sourceHead !== ownedPrevious.sourceHead
            )
              return yield* invalid()
            // A crash can occur after the replacement row is committed but before the old
            // conflict coordinator is removed.  Re-validate and clean that obsolete scratch
            // checkout before resuming the replacement; a replaced path is left untouched.
            yield* removeCoordinator(ownedPrevious)
            return yield* prepareLocked({ id: replacement.id, taskId: replacement.taskId, expectedSourceHead: replacement.sourceHead })
          }
          const next = yield* sql.withTransaction(
            Effect.gen(function* () {
              const previous = yield* find(value.supersededId)
              if (!previous) return yield* new HarnessStoreError({ reason: 'not-found', message: 'Synchronization was not found.' })
              if (previous.taskId !== value.taskId)
                return yield* new HarnessStoreError({ reason: 'not-found', message: 'Synchronization was not found.' })
              const canReplayConflict = previous.state === 'conflict' || previous.state === 'resolving'
              if (!canReplayConflict && (previous.state !== 'prepared' && previous.state !== 'superseded')) return yield* invalid()
              if (!canReplayConflict && !previous.preparedHead) return yield* invalid()
              if (previous.publishedHead || previous.alignedHead || previous.alignmentCommit || previous.alignmentData) return yield* invalid()
              const children = yield* sql<{ id: string }>`SELECT id FROM git_sync_operations WHERE supersedes_id=${previous.id}`
              if (children.length) return yield* invalid()
              if (canReplayConflict) yield* retainCanonicalPrefix(previous)
              else yield* retain(previous)
              const { taskPath } = yield* checkouts(previous.taskId)
              const mainHead = (yield* git(main, ['rev-parse', 'HEAD'])).trim()
              const taskHead = (yield* git(taskPath, ['rev-parse', 'HEAD'])).trim()
              if (
                mainHead === previous.mainBase ||
                (previous.preparedHead !== null && mainHead === previous.preparedHead) ||
                taskHead !== previous.sourceHead ||
                (yield* git(main, ['status', '--porcelain', '--untracked-files=all'])).trim() ||
                (yield* git(taskPath, ['status', '--porcelain', '--untracked-files=all'])).trim()
              )
                return yield* invalid()
              yield* git(main, ['merge-base', '--is-ancestor', previous.mainBase, mainHead]).pipe(Effect.mapError(invalid))
              const marker = yield* fs
                .readFileString(join(main, '.git/folio-workspace.json'))
                .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ version: Schema.Literal(1), initialCommit: GitObjectId })))))
              if (!(yield* isRegisteredGitCommit('main', mainHead, marker.initialCommit))) return yield* invalid()
              if (previous.state !== 'superseded') {
                const changed = yield* sql`UPDATE git_sync_operations SET state='superseded'
                WHERE id=${previous.id} AND state IN ('prepared', 'conflict', 'resolving') RETURNING id`
                if (!changed.length) return yield* invalid()
              }
              const next = yield* reserve({ id: value.id, taskId: previous.taskId, expectedSourceHead: previous.sourceHead }, previous.id)
              // The replacement follows supersedes_id back to immutable resolution inputs. It
              // does not copy them, so a replay conflict can accept a newer resolution under the
              // replacement operation without rewriting old evidence.
              return next
            })
          )
          if (next.supersedesId !== value.supersededId || next.taskId !== value.taskId) return yield* invalid()
          const prepared = yield* prepareLocked({ id: next.id, taskId: next.taskId, expectedSourceHead: next.sourceHead })
          if (ownedPrevious.state === 'conflict' || ownedPrevious.state === 'resolving') yield* removeCoordinator(ownedPrevious)
          return prepared
        })

        /** Publishes only against the frozen, clean main; a matching HEAD recovers a lost receipt. */
        const publishLocked = Effect.fn('TaskGitSynchronization.publishLocked')(function* (id: string) {
          let row = yield* find(id)
          if (!row) return yield* new HarnessStoreError({ reason: 'not-found', message: 'Synchronization was not found.' })
          if (row.state === 'published' || row.state === 'aligning' || row.state === 'aligned' || row.state === 'superseded') return row
          if (row.state !== 'prepared' || !row.preparedHead) return yield* invalid()
          yield* retain(row)
          yield* checkouts(row.taskId)
          const current = (yield* git(main, ['rev-parse', 'HEAD'])).trim()
          if (current !== row.mainBase && current !== row.preparedHead) return yield* invalid()
          if ((yield* git(main, ['status', '--porcelain', '--untracked-files=all'])).trim()) return yield* invalid()
          if (current === row.mainBase && current !== row.preparedHead) yield* git(main, ['merge', '--ff-only', row.preparedHead])
          if (
            (yield* symbolicHead(main)) !== 'refs/heads/main' ||
            (yield* git(main, ['rev-parse', 'refs/heads/main'])).trim() !== row.preparedHead ||
            (yield* git(main, ['rev-parse', 'HEAD'])).trim() !== row.preparedHead ||
            (yield* git(main, ['status', '--porcelain', '--untracked-files=all'])).trim()
          )
            return yield* invalid()
          yield* sql`UPDATE git_sync_operations SET published_head=${row.preparedHead}, state='published'
          WHERE id=${row.id} AND state='prepared'`
          row = (yield* find(row.id))!
          return row
        })

        /** Aligns only the latest publication and never overwrites a dirty or advanced Task checkout. */
        const alignLocked = Effect.fn('TaskGitSynchronization.alignLocked')(function* (id: string) {
          let row = yield* find(id)
          if (!row) return yield* new HarnessStoreError({ reason: 'not-found', message: 'Synchronization was not found.' })
          if (row.state === 'aligned' || row.state === 'superseded') return row
          if ((row.state !== 'published' && row.state !== 'aligning') || !row.publishedHead) return yield* invalid()
          const latest = yield* sql<{ sequence: number }>`SELECT sequence FROM git_sync_operations
          WHERE task_id=${row.taskId} AND state NOT IN ('aligned', 'superseded', 'aborted') ORDER BY sequence DESC LIMIT 1`
          if (latest[0]?.sequence !== row.sequence) return row
          const { taskPath } = yield* checkouts(row.taskId)
          const current = (yield* git(taskPath, ['rev-parse', 'HEAD'])).trim()
          if (row.state === 'aligning') yield* retainAlignment(row)
          if (
            row.state === 'aligning' &&
            row.alignmentCommit &&
            current === row.alignmentCommit &&
            !(yield* git(taskPath, ['status', '--porcelain', '--untracked-files=all'])).trim()
          ) {
            // Git moved the Task ref/worktree before the database receipt was persisted.
          } else {
            if (current !== row.sourceHead || (yield* git(taskPath, ['status', '--porcelain', '--untracked-files=all'])).trim()) {
              return yield* invalid()
            }
            const canonicalTree = (yield* git(main, ['rev-parse', `${row.publishedHead}^{tree}`])).trim()
            const taskTree = (yield* git(taskPath, ['rev-parse', 'HEAD^{tree}'])).trim()
            if (canonicalTree === taskTree) {
              yield* sql`UPDATE git_sync_operations SET aligned_head=${current}, state='aligned'
              WHERE task_id=${row.taskId} AND sequence<=${row.sequence} AND state='published'`
              return (yield* find(row.id))!
            }
            if (row.state === 'published') {
              const data = gitCommitData({
                tree: canonicalTree,
                parent: row.sourceHead,
                createdAt: row.createdAt,
                message: `Canonical Task alignment\n\nFolio-Sync-Operation: ${row.id}\nFolio-Canonical-Commit: ${row.publishedHead}\nFolio-Task-Id: ${row.taskId}\n`
              })
              const commit = gitCommitHash(data, yield* objectFormat())
              yield* sql`UPDATE git_sync_operations SET alignment_commit=${commit}, alignment_data=${data}, state='aligning'
              WHERE id=${row.id} AND state='published' AND alignment_commit IS NULL`
              row = (yield* find(row.id))!
            }
            const alignmentCommit = yield* retainAlignment(row)
            yield* git(taskPath, ['merge', '--ff-only', alignmentCommit])
          }
          const alignedHead = (yield* git(taskPath, ['rev-parse', 'HEAD'])).trim()
          if (
            alignedHead !== row.alignmentCommit ||
            (yield* git(taskPath, ['status', '--porcelain', '--untracked-files=all'])).trim() ||
            (yield* git(taskPath, ['rev-parse', 'HEAD^{tree}'])).trim() !== (yield* git(main, ['rev-parse', `${row.publishedHead}^{tree}`])).trim()
          )
            return yield* invalid()
          yield* sql`UPDATE git_sync_operations SET aligned_head=${alignedHead}, state='aligned'
          WHERE task_id=${row.taskId} AND sequence<=${row.sequence} AND state IN ('published', 'aligning')`
          return (yield* find(row.id))!
        })

        /** Database ordering and raw commit bytes never cross the service boundary. */
        const receipt = ({ sequence: _, alignmentData: __, ...row }: Row): GitSyncOperationValue => row
        /** Captures a Task's frozen wiki source interval and prepares an isolated canonical result. */
        const prepare = (input: SynchronizeTaskWiki) => lock.withLock(prepareLocked(input).pipe(Effect.provide(dependencies), Effect.map(receipt), Effect.mapError(storage)))
        /** Replaces stale preparation on the current main while replaying accepted conflict resolutions. */
        const prepareReplacement = (input: ReprepareTaskWiki) =>
          lock.withLock(reprepareLocked(input).pipe(Effect.provide(dependencies), Effect.map(receipt), Effect.mapError(storage)))
        /** Publishes a prepared canonical commit to main after rechecking the recorded base and dirtiness. */
        const publish = (id: string) => lock.withLock(publishLocked(id).pipe(Effect.provide(dependencies), Effect.map(receipt), Effect.mapError(storage)))
        /** Aligns the Task worktree to a published canonical tree with a normal child commit. */
        const align = (id: string) => lock.withLock(alignLocked(id).pipe(Effect.provide(dependencies), Effect.map(receipt), Effect.mapError(storage)))
        /** Accepts a completely staged coordinator resolution and resumes canonical preparation. */
        const resolvePreparation = (id: string) =>
          lock.withLock(resolveLocked(id).pipe(Effect.provide(dependencies), Effect.map(receipt), Effect.mapError(storage)))
        const resolutionDirectory = (taskId: string, id: string) => lock.withLock(
          conflictCheckout(taskId, id).pipe(Effect.provide(dependencies), Effect.map(({ coordinator }) => coordinator), Effect.mapError(storage))
        )
        const resolutionContext = (taskId: string, id: string) => lock.withLock(
          resolutionContextLocked(taskId, id).pipe(Effect.provide(dependencies), Effect.mapError(storage))
        )
        const acceptAgentResolution = (taskId: string, id: string, runId: string) => lock.withLock(
          acceptAgentResolutionLocked(taskId, id, runId).pipe(Effect.provide(dependencies), Effect.map(receipt), Effect.mapError(storage))
        )
        const abort = (id: string) => lock.withLock(abortLocked(id).pipe(Effect.provide(dependencies), Effect.map(receipt), Effect.mapError(storage)))
        /** Runs prepare, publish, and align as one idempotent synchronized workflow. */
        const synchronize = Effect.fn('TaskGitSynchronization.synchronize')(function* (input: SynchronizeTaskWiki) {
          let row = yield* prepare(input)
          if (row.state !== 'prepared' && row.state !== 'published' && row.state !== 'aligning' && row.state !== 'aligned') return row
          row = yield* publish(row.id)
          return yield* align(row.id)
        }, Effect.mapError(storage))
        /** Reprepares a stale or resolving operation, then continues publication and alignment when possible. */
        const reprepare = Effect.fn('TaskGitSynchronization.reprepare')(function* (input: ReprepareTaskWiki) {
          let row = yield* prepareReplacement(input)
          if (row.state !== 'prepared' && row.state !== 'published' && row.state !== 'aligning' && row.state !== 'aligned') return row
          row = yield* publish(row.id)
          return yield* align(row.id)
        }, Effect.mapError(storage))
        /** Completes a coordinator conflict resolution and continues the durable sync workflow. */
        const resolveConflict = Effect.fn('TaskGitSynchronization.resolve')(function* (id: string) {
          let row = yield* resolvePreparation(id)
          if (row.state === 'conflict') return row
          row = yield* publish(row.id)
          return yield* align(row.id)
        }, Effect.mapError(storage))
        /** Returns a public synchronization receipt without exposing internal sequence or commit bytes. */
        const get = Effect.fn('TaskGitSynchronization.get')(function* (id: string) {
          const row = yield* find(id)
          if (!row) return yield* new HarnessStoreError({ reason: 'not-found', message: 'Synchronization was not found.' })
          return receipt(row)
        }, Effect.mapError(storage))
        const pending = sql`SELECT sequence, id, task_id AS taskId, supersedes_id AS supersedesId, source_frontier AS sourceFrontier,
        source_head AS sourceHead, source_changes AS sourceChanges, source_commits AS sourceCommits,
        main_base AS mainBase, canonical_commits AS canonicalCommits, conflict_index AS conflictIndex, prepared_head AS preparedHead,
        published_head AS publishedHead, aligned_head AS alignedHead, alignment_commit AS alignmentCommit,
        alignment_data AS alignmentData, state, created_at AS createdAt FROM git_sync_operations
        WHERE state NOT IN ('aligned', 'superseded', 'aborted') ORDER BY sequence`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Row))),
          Effect.map((rows) => rows.map(receipt)),
          Effect.mapError(storage)
        )
        return TaskGitSynchronization.of({ prepare, publish, align, synchronize, reprepare, resolve: resolveConflict,
          resolutionDirectory, resolutionContext, acceptAgentResolution, abort, get, pending })
      }).pipe(Effect.mapError(storage))
    ).pipe(Layer.provide(VaultGitWriteLock.layer(directory)))
  }
}
