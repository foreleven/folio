import { Context, DateTime, Effect, FileSystem, Layer, Schema } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { ChildProcessSpawner } from 'effect/unstable/process'
import { lstat } from 'node:fs/promises'
import { join, resolve as resolvePath } from 'node:path'
import {
  GitConflictContext,
  GitObjectId,
  ReprepareTaskWiki,
  SynchronizeTaskWiki,
  type GitSyncOperation as GitSyncOperationValue
} from '../../../shared/git-change'
import { HarnessStoreError } from '../../../shared/harness'
import { gitCommitData, gitCommitHash } from '../git/git-commit-object'
import { isRegisteredGitCommit } from '../git/git-change-applications'
import { operationFilePath, readSyncOperationFile, SyncOperationFile, writeSyncOperationFile } from '../git/git-operation-files'
import { withGitOperationGate } from '../git/git-operation-gate'
import { makeVaultGit } from '../git/vault-git'
import { HarnessStore } from '../harness/harness-store'

const OperationRow = Schema.Struct({
  sequence: Schema.Int,
  id: Schema.String,
  taskId: Schema.String,
  state: Schema.Literals(['pending', 'conflict', 'prepared', 'published', 'completed', 'aborted']),
  sourceHead: GitObjectId,
  targetCommit: Schema.NullOr(GitObjectId),
  artifactPath: Schema.NullOr(Schema.String),
  createdAt: Schema.Int
})
type OperationRow = typeof OperationRow.Type
const invalid = () => new HarnessStoreError({ reason: 'invalid-state', message: 'Task synchronization changed or requires inspection.' })
const storage = (cause: unknown) =>
  cause instanceof HarnessStoreError
    ? cause
    : new HarnessStoreError({ reason: 'storage', message: 'Task synchronization could not finish. Its local recovery files were retained.' })

export interface GitConflictResolutionContext extends GitConflictContext {
  readonly directory: string
  readonly files: readonly string[]
  readonly commonBase: string
  readonly canonicalDiff: string
  readonly taskDiff: string
}

/** Publishes one Task layer onto main; detailed replay state is kept in local operation files. */
export class TaskGitSynchronization extends Context.Service<
  TaskGitSynchronization,
  {
    readonly prepare: (input: SynchronizeTaskWiki) => Effect.Effect<GitSyncOperationValue, HarnessStoreError>
    readonly publish: (id: string) => Effect.Effect<GitSyncOperationValue, HarnessStoreError>
    readonly align: (id: string) => Effect.Effect<GitSyncOperationValue, HarnessStoreError>
    readonly synchronize: (input: SynchronizeTaskWiki) => Effect.Effect<GitSyncOperationValue, HarnessStoreError>
    readonly reprepare: (input: ReprepareTaskWiki) => Effect.Effect<GitSyncOperationValue, HarnessStoreError>
    readonly resolve: (id: string) => Effect.Effect<GitSyncOperationValue, HarnessStoreError>
    readonly resolutionDirectory: (taskId: string, id: string) => Effect.Effect<string, HarnessStoreError>
    readonly resolutionContext: (taskId: string, id: string) => Effect.Effect<GitConflictResolutionContext, HarnessStoreError>
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
        const git = yield* makeVaultGit
        const dependencies = yield* Effect.context<FileSystem.FileSystem | SqlClient.SqlClient | ChildProcessSpawner.ChildProcessSpawner>()
        const root = yield* fs.realPath(directory)
        const main = join(root, 'workspace')
        const coordinatorParent = join(root, 'sync-worktrees')

        const now = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis))
        const symbolicHead = (path: string) => git(path, ['symbolic-ref', 'HEAD']).pipe(
          Effect.map((value) => value.trim()),
          Effect.catch(() => Effect.succeed(''))
        )
        const receipt = (row: OperationRow): GitSyncOperationValue => ({
          id: row.id,
          taskId: row.taskId,
          sourceHead: row.sourceHead,
          publishedHead: row.state === 'published' || row.state === 'completed' ? row.targetCommit : null,
          state: row.state,
          createdAt: row.createdAt
        })

        const find = Effect.fn('TaskGitSynchronization.find')(function* (id: string) {
          const rows = yield* sql`SELECT sequence, id, task_id AS taskId, state,
            source_commit AS sourceHead, target_commit AS targetCommit,
            artifact_path AS artifactPath, created_at AS createdAt
            FROM git_operations WHERE id=${id} AND kind='synchronize'`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(OperationRow)))
          )
          return rows[0]
        })

        const artifact = Effect.fn('TaskGitSynchronization.artifact')(function* (row: OperationRow) {
          if (!row.artifactPath) return yield* invalid()
          const value = yield* readSyncOperationFile(root, row.artifactPath)
          if (value.id !== row.id || value.taskId !== row.taskId || value.sourceHead !== row.sourceHead) return yield* invalid()
          return value
        })

        const saveArtifact = (value: SyncOperationFile) => writeSyncOperationFile(root, value)
        const coordinatorPath = (id: string) => join(coordinatorParent, id)
        const resolutionPatchPath = (id: string) => join(operationFilePath(root, id).directory, 'resolution.patch')

        /** Validates the two Folio-owned checkouts without inferring state from database paths. */
        const checkouts = Effect.fn('TaskGitSynchronization.checkouts')(function* (taskId: string) {
          const task = yield* store.task(taskId)
          const taskPath = join(root, 'worktrees', taskId)
          const branch = `folio/task/${taskId}`
          const usable = task.state === 'active' || (task.type === 'ingestion' && task.state === 'completed')
          if (!usable || task.worktreeState !== 'ready' || !task.worktreeBase) return yield* invalid()
          if (
            (yield* fs.realPath(main)) !== main ||
            (yield* fs.realPath(join(main, '.git'))) !== join(main, '.git') ||
            (yield* fs.realPath(taskPath)) !== taskPath ||
            (yield* git(main, ['rev-parse', '--show-toplevel'])).trim() !== main ||
            (yield* symbolicHead(main)) !== 'refs/heads/main' ||
            (yield* git(taskPath, ['rev-parse', '--show-toplevel'])).trim() !== taskPath ||
            (yield* symbolicHead(taskPath)) !== `refs/heads/${branch}` ||
            (yield* fs.realPath(resolvePath(taskPath, (yield* git(taskPath, ['rev-parse', '--git-common-dir'])).trim()))) !== join(main, '.git')
          ) return yield* invalid()
          if ((yield* sql`SELECT id FROM runs WHERE task_id=${taskId} AND state IN ('preparing', 'running')`).length)
            return yield* new HarnessStoreError({ reason: 'task-busy', message: 'Task has an active Run.' })
          return { task, taskPath, branch }
        })

        const taskPolicy = Effect.fn('TaskGitSynchronization.taskPolicy')(function* (taskId: string) {
          const task = yield* store.task(taskId)
          if (task.type === 'agent') return { kinds: ['save-user', 'save-wiki'] as const, prefix: 'wiki/', pathspec: 'wiki' }
          const rows = yield* sql<{ routineDate: string | null }>`SELECT routine_date AS routineDate FROM tasks WHERE id=${taskId}`
          const date = rows[0]?.routineDate
          if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
            [task.configuration.integrationId, task.configuration.resourceId].some((value) => !/^[a-zA-Z0-9_-]+$/.test(value))) return yield* invalid()
          const pathspec = `raws/${task.configuration.integrationId}/${task.configuration.resourceId}/${date}`
          return { kinds: ['save-raws'] as const, prefix: `${pathspec}/`, pathspec }
        })

        const isRegisteredMain = Effect.fn('TaskGitSynchronization.isRegisteredMain')(function* (commit: string) {
          const marker = yield* fs.readFileString(join(main, '.git', 'folio-workspace.json')).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ version: Schema.Literal(1), initialCommit: GitObjectId }))))
          )
          return yield* isRegisteredGitCommit('main', commit, marker.initialCommit)
        })

        const removeCoordinator = Effect.fn('TaskGitSynchronization.removeCoordinator')(function* (id: string) {
          const path = coordinatorPath(id)
          if (!(yield* fs.exists(path))) return
          const info = yield* Effect.tryPromise(() => lstat(join(path, '.git')))
          if (!info.isFile() || info.isSymbolicLink() || (yield* fs.realPath(path)) !== path ||
            (yield* fs.realPath(resolvePath(path, (yield* git(path, ['rev-parse', '--git-common-dir'])).trim()))) !== join(main, '.git')) return yield* invalid()
          yield* git(main, ['worktree', 'remove', '--force', path])
        })

        const updateRunStates = Effect.fn('TaskGitSynchronization.updateRunStates')(function* (value: SyncOperationFile, state: 'syncing' | 'conflict' | 'completed' | 'failed') {
          for (const commit of value.sourceCommits) {
            yield* sql`UPDATE runs SET sync_state=${state} WHERE id IN (
              SELECT owner.run_id FROM git_operations operation
              JOIN git_operation_runs owner ON owner.operation_id=operation.id
              WHERE operation.task_id=${value.taskId} AND operation.target_commit=${commit} AND operation.kind='save-wiki'
            )`
          }
        })

        const retainTarget = Effect.fn('TaskGitSynchronization.retainTarget')(function* (id: string, base: string, commit: string) {
          const ref = `refs/folio/operations/${id}/attempts/${base}`
          const current = (yield* git(main, ['for-each-ref', '--format=%(objectname)', ref])).trim()
          if (current && current !== commit) return yield* invalid()
          if (!current) yield* git(main, ['update-ref', '--no-deref', ref, commit, '0'.repeat(commit.length)])
        })

        const retainResolutionTree = Effect.fn('TaskGitSynchronization.retainResolutionTree')(function* (id: string, tree: string) {
          const ref = `refs/folio/operations/${id}/resolutions/${tree}`
          const current = (yield* git(main, ['for-each-ref', '--format=%(objectname)', ref])).trim()
          if (current && current !== tree) return yield* invalid()
          if (!current) yield* git(main, ['update-ref', '--no-deref', ref, tree, '0'.repeat(tree.length)])
        })

        const createTarget = Effect.fn('TaskGitSynchronization.createTarget')(function* (value: SyncOperationFile, tree: string) {
          const baseTree = (yield* git(main, ['rev-parse', `${value.mainBase}^{tree}`])).trim()
          if (tree === baseTree) return value.mainBase
          const data = gitCommitData({
            tree,
            parent: value.mainBase,
            createdAt: value.createdAt,
            message: `Publish Task layer\n\nFolio-Operation-Id: ${value.id}\nFolio-Task-Id: ${value.taskId}\nFolio-Source-Commit: ${value.sourceHead}\n`
          })
          const format = yield* Schema.decodeUnknownEffect(Schema.Literals(['sha1', 'sha256']))((yield* git(main, ['rev-parse', '--show-object-format'])).trim())
          const commit = gitCommitHash(data, format)
          if ((yield* git(main, ['hash-object', '-t', 'commit', '-w', '--stdin'], { input: data })).trim() !== commit) return yield* invalid()
          yield* retainTarget(value.id, value.mainBase, commit)
          return commit
        })

        /** Rebuilds scratch from immutable source commits, or from an accepted local patch. */
        const prepareExisting = Effect.fn('TaskGitSynchronization.prepareExisting')(function* (row: OperationRow) {
          if (row.state !== 'pending') return row
          let value = yield* artifact(row)
          const { taskPath } = yield* checkouts(row.taskId)
          if ((yield* git(taskPath, ['rev-parse', 'HEAD'])).trim() !== value.sourceHead) return yield* invalid()
          const mainHead = (yield* git(main, ['rev-parse', 'HEAD'])).trim()
          if ((yield* git(main, ['status', '--porcelain', '--untracked-files=all'])).trim() ||
            (yield* git(taskPath, ['status', '--porcelain', '--untracked-files=all'])).trim()) return yield* invalid()
          if (mainHead !== value.mainBase) {
            yield* git(main, ['merge-base', '--is-ancestor', value.mainBase, mainHead]).pipe(Effect.mapError(invalid))
            if (!(yield* isRegisteredMain(mainHead))) return yield* invalid()
            value = { ...value, mainBase: mainHead, conflictKind: null, conflictIndex: null,
              resolutionTree: null, alignmentHead: null }
            // Pending rows intentionally accept either checkpoint after a crash; both rebuild
            // from immutable source commits and the current registered main descendant.
            yield* saveArtifact(value)
          }
          yield* fs.makeDirectory(coordinatorParent, { recursive: true })
          if ((yield* fs.realPath(coordinatorParent)) !== coordinatorParent) return yield* invalid()
          yield* removeCoordinator(row.id)
          const coordinator = coordinatorPath(row.id)
          yield* git(main, ['worktree', 'prune'])
          yield* git(main, ['worktree', 'add', '--detach', coordinator, value.mainBase])
          const policy = yield* taskPolicy(row.taskId)
          const resolutionPath = resolutionPatchPath(row.id)
          let conflictKind: 'source' | 'resolution' | null = null
          let conflictIndex: number | null = null
          if (yield* fs.exists(resolutionPath)) {
            const patch = yield* fs.readFileString(resolutionPath)
            const applied = patch === '' ? true : yield* git(coordinator, ['apply', '--3way', '--index'], { input: patch }).pipe(
              Effect.as(true),
              Effect.catch(() => Effect.succeed(false))
            )
            if (!applied) conflictKind = 'resolution'
          } else {
            for (const [index, commit] of value.sourceCommits.entries()) {
              const applied = yield* git(coordinator, ['cherry-pick', '--no-commit', commit]).pipe(
                Effect.as(true),
                Effect.catch(() => Effect.succeed(false))
              )
              if (!applied) { conflictKind = 'source'; conflictIndex = index; break }
            }
          }
          if (conflictKind !== null) {
            const files = (yield* git(coordinator, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean)
            if (!files.length || files.some((path) => !path.startsWith(policy.prefix))) return yield* invalid()
            value = { ...value, conflictKind, conflictIndex, resolutionTree: null }
            yield* saveArtifact(value)
            yield* sql.withTransaction(Effect.gen(function* () {
              yield* sql`UPDATE git_operations SET state='conflict', target_commit=${value.mainBase}, updated_at=${yield* now}
                WHERE id=${row.id} AND state='pending'`
              yield* updateRunStates(value, 'conflict')
            }))
            return (yield* find(row.id))!
          }
          const changed = (yield* git(coordinator, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean)
          if (changed.some((path) => !path.startsWith(policy.prefix))) return yield* invalid()
          const tree = (yield* git(coordinator, ['write-tree'])).trim()
          const target = yield* createTarget(value, tree)
          yield* sql`UPDATE git_operations SET state='prepared', target_commit=${target}, updated_at=${yield* now}
            WHERE id=${row.id} AND state='pending'`
          yield* removeCoordinator(row.id)
          return (yield* find(row.id))!
        })

        /** Freezes the Task suffix using save receipts, never serialized commit/path columns. */
        const reserve = Effect.fn('TaskGitSynchronization.reserve')(function* (input: typeof SynchronizeTaskWiki.Type) {
          const value = yield* Schema.decodeUnknownEffect(SynchronizeTaskWiki)(input, { onExcessProperty: 'error' })
          const previous = yield* find(value.id)
          if (previous) {
            if (previous.taskId !== value.taskId || previous.sourceHead !== value.expectedSourceHead) return yield* invalid()
            return previous
          }
          const { task, taskPath } = yield* checkouts(value.taskId)
          const sourceHead = (yield* git(taskPath, ['rev-parse', 'HEAD'])).trim()
          if (sourceHead !== value.expectedSourceHead) return yield* invalid()
          const latest = (yield* sql<{ target: string }>`SELECT target_commit AS target FROM git_operations
            WHERE task_id=${value.taskId} AND kind='synchronize' AND state='completed' ORDER BY sequence DESC LIMIT 1`)[0]?.target
          const sourceFrontier = latest && (yield* git(taskPath, ['merge-base', '--is-ancestor', latest, sourceHead]).pipe(
            Effect.as(true), Effect.catch(() => Effect.succeed(false)))) ? latest : task.worktreeBase!
          const listed = (yield* git(taskPath, ['rev-list', '--reverse', '--first-parent', `${sourceFrontier}..${sourceHead}`])).trim()
          const sourceCommits = listed ? listed.split('\n') : []
          const policy = yield* taskPolicy(value.taskId)
          for (const commit of sourceCommits) {
            const owner = (yield* sql<{ kind: string }>`SELECT kind FROM git_operations WHERE task_id=${value.taskId}
              AND target_commit=${commit} AND state='completed'`)[0]
            if (!owner || !policy.kinds.includes(owner.kind as never)) return yield* invalid()
            const paths = (yield* git(taskPath, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', `${commit}^`, commit])).split('\0').filter(Boolean)
            if (!paths.length || paths.some((path) => !path.startsWith(policy.prefix))) return yield* invalid()
          }
          const mainBase = (yield* git(main, ['rev-parse', 'HEAD'])).trim()
          if (!(yield* isRegisteredMain(mainBase)) ||
            (yield* git(main, ['status', '--porcelain', '--untracked-files=all'])).trim()) return yield* invalid()
          const createdAt = yield* now
          const file: SyncOperationFile = { version: 1, id: value.id, taskId: value.taskId, sourceFrontier,
            sourceHead, sourceCommits, mainBase, conflictKind: null, conflictIndex: null,
            resolutionTree: null, alignmentHead: null, createdAt }
          const artifactPath = yield* saveArtifact(file)
          yield* sql.withTransaction(Effect.gen(function* () {
            yield* sql`INSERT INTO git_operations
              (id, task_id, kind, state, source_commit, target_commit, artifact_path, created_at, updated_at)
              VALUES (${value.id}, ${value.taskId}, 'synchronize', 'pending', ${sourceHead}, NULL, ${artifactPath}, ${createdAt}, ${createdAt})`
            yield* updateRunStates(file, 'syncing')
          }))
          return (yield* find(value.id))!
        })

        const prepareLocked = Effect.fn('TaskGitSynchronization.prepareLocked')(function* (input: typeof SynchronizeTaskWiki.Type) {
          const row = yield* reserve(input)
          return row.state === 'pending' ? yield* prepareExisting(row) : row
        })

        /** Rebuilds against a newer main and retries CAS instead of creating a durable database lock. */
        const publishLocked = Effect.fn('TaskGitSynchronization.publishLocked')(function* (id: string) {
          let row = yield* find(id)
          if (!row) return yield* new HarnessStoreError({ reason: 'not-found', message: 'Synchronization was not found.' })
          if (row.state === 'published' || row.state === 'completed') return row
          for (let attempt = 0; attempt < 3; attempt += 1) {
            if (row.state === 'pending') row = yield* prepareExisting(row)
            if (row.state === 'conflict') return row
            if (row.state !== 'prepared' || !row.targetCommit) return yield* invalid()
            const value = yield* artifact(row)
            const current = (yield* git(main, ['rev-parse', 'HEAD'])).trim()
            if ((yield* git(main, ['status', '--porcelain', '--untracked-files=all'])).trim()) return yield* invalid()
            if (current === value.mainBase) {
              if (row.targetCommit !== current) yield* git(main, ['merge', '--ff-only', row.targetCommit])
              yield* sql`UPDATE git_operations SET state='published', updated_at=${yield* now}
                WHERE id=${row.id} AND state='prepared'`
              return (yield* find(row.id))!
            }
            if (current === row.targetCommit) {
              yield* sql`UPDATE git_operations SET state='published', updated_at=${yield* now}
                WHERE id=${row.id} AND state='prepared'`
              return (yield* find(row.id))!
            }
            yield* git(main, ['merge-base', '--is-ancestor', value.mainBase, current]).pipe(Effect.mapError(invalid))
            if (!(yield* isRegisteredMain(current))) return yield* invalid()
            const refreshed: SyncOperationFile = { ...value, mainBase: current, conflictKind: null, conflictIndex: null,
              resolutionTree: null, alignmentHead: null }
            yield* sql`UPDATE git_operations SET state='pending', target_commit=NULL, updated_at=${yield* now}
              WHERE id=${row.id} AND state='prepared'`
            // Once the row is pending, either the old or new artifact is safe to rebuild. Updating
            // the file first could pair a prepared target with a different main baseline on crash.
            yield* saveArtifact(refreshed)
            row = (yield* find(row.id))!
          }
          return yield* invalid()
        })

        /** Resets the clean Folio-owned Task checkout to the latest main checkpoint. */
        const alignLocked = Effect.fn('TaskGitSynchronization.alignLocked')(function* (id: string) {
          let row = yield* find(id)
          if (!row) return yield* new HarnessStoreError({ reason: 'not-found', message: 'Synchronization was not found.' })
          if (row.state === 'completed' || row.state === 'aborted') return row
          if (row.state !== 'published' || !row.targetCommit) return yield* invalid()
          const value = yield* artifact(row)
          const { taskPath } = yield* checkouts(row.taskId)
          const mainHead = (yield* git(main, ['rev-parse', 'HEAD'])).trim()
          yield* git(main, ['merge-base', '--is-ancestor', row.targetCommit, mainHead]).pipe(Effect.mapError(invalid))
          const alignmentHead = value.alignmentHead ?? mainHead
          yield* git(main, ['merge-base', '--is-ancestor', row.targetCommit, alignmentHead]).pipe(Effect.mapError(invalid))
          yield* git(main, ['merge-base', '--is-ancestor', alignmentHead, mainHead]).pipe(Effect.mapError(invalid))
          if (!(yield* isRegisteredMain(alignmentHead))) return yield* invalid()
          const taskHead = (yield* git(taskPath, ['rev-parse', 'HEAD'])).trim()
          if (taskHead !== value.sourceHead && taskHead !== row.targetCommit && taskHead !== alignmentHead) return yield* invalid()
          if ((yield* git(taskPath, ['status', '--porcelain', '--untracked-files=all'])).trim()) return yield* invalid()
          // Persist the exact reset destination first. A later main advance cannot make a
          // post-reset/pre-receipt crash ambiguous on retry.
          if (value.alignmentHead === null) yield* saveArtifact({ ...value, alignmentHead })
          if (taskHead !== alignmentHead) yield* git(taskPath, ['reset', '--hard', alignmentHead])
          yield* sql.withTransaction(Effect.gen(function* () {
            const changed = yield* sql`UPDATE git_operations SET state='completed', target_commit=${alignmentHead}, artifact_path=NULL,
              updated_at=${yield* now} WHERE id=${row.id} AND state='published' RETURNING id`
            if (!changed.length) return yield* invalid()
            yield* updateRunStates(value, 'completed')
          }))
          yield* fs.remove(operationFilePath(root, row.id).directory, { recursive: true }).pipe(Effect.catch(() => Effect.void))
          row = (yield* find(row.id))!
          return row
        })

        const conflictCheckout = Effect.fn('TaskGitSynchronization.conflictCheckout')(function* (taskId: string, id: string) {
          const row = yield* find(id)
          if (!row || row.taskId !== taskId) return yield* new HarnessStoreError({ reason: 'not-found', message: 'Synchronization was not found.' })
          if (row.state !== 'conflict') return yield* invalid()
          const value = yield* artifact(row)
          const coordinator = coordinatorPath(id)
          const info = yield* Effect.tryPromise(() => lstat(join(coordinator, '.git')))
          if (!info.isFile() || info.isSymbolicLink() || (yield* fs.realPath(coordinator)) !== coordinator ||
            (yield* symbolicHead(coordinator)) !== '' ||
            (yield* fs.realPath(resolvePath(coordinator, (yield* git(coordinator, ['rev-parse', '--git-common-dir'])).trim()))) !== join(main, '.git')) return yield* invalid()
          return { row, value, coordinator }
        })

        /** Accepts the staged resolution and records its patch locally for a later main rebuild. */
        const finishConflict = Effect.fn('TaskGitSynchronization.finishConflict')(function* (row: OperationRow, value: SyncOperationFile, coordinator: string) {
          const policy = yield* taskPolicy(row.taskId)
          if ((yield* git(coordinator, ['diff', '--name-only', '--diff-filter=U', '-z'])).length ||
            (yield* git(coordinator, ['diff', '--name-only', '-z'])).length ||
            (yield* git(coordinator, ['ls-files', '--others', '--exclude-standard', '-z'])).length) return yield* invalid()
          const staged = (yield* git(coordinator, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean)
          if (staged.some((path) => !path.startsWith(policy.prefix))) return yield* invalid()
          if (value.conflictKind === null) return yield* invalid()
          const resolvedIndex = value.conflictIndex
          if (value.conflictKind === 'source' && (resolvedIndex === null || !value.sourceCommits[resolvedIndex])) return yield* invalid()
          let checkpoint = value
          if (checkpoint.resolutionTree === null) {
            const resolutionTree = (yield* git(coordinator, ['write-tree'])).trim()
            yield* retainResolutionTree(row.id, resolutionTree)
            checkpoint = { ...checkpoint, resolutionTree }
            // Freeze the accepted answer before mutating the coordinator with suffix replay.
            yield* saveArtifact(checkpoint)
          } else {
            yield* retainResolutionTree(row.id, checkpoint.resolutionTree)
          }
          // Source conflicts stop in the middle of the frozen sequence, so replay its suffix.
          // A resolution-patch conflict already represents the complete sequence and has no suffix.
          const replayFrom = checkpoint.conflictKind === 'source' ? resolvedIndex! + 1 : checkpoint.sourceCommits.length
          const cherryPickHead = join((yield* git(coordinator, ['rev-parse', '--absolute-git-dir'])).trim(), 'CHERRY_PICK_HEAD')
          if (yield* fs.exists(cherryPickHead)) yield* git(coordinator, ['cherry-pick', '--quit'])
          // Always rebuild from the frozen answer. Repeating finish after a receipt failure
          // therefore never reapplies a successful suffix onto itself.
          yield* git(coordinator, ['reset', '--hard', checkpoint.mainBase])
          yield* git(coordinator, ['restore', `--source=${checkpoint.resolutionTree}`, '--staged', '--worktree', '--', '.'])
          for (let index = replayFrom; index < checkpoint.sourceCommits.length; index += 1) {
            const applied = yield* git(coordinator, ['cherry-pick', '--no-commit', checkpoint.sourceCommits[index]!]).pipe(
              Effect.as(true),
              Effect.catch(() => Effect.succeed(false))
            )
            if (!applied) {
              const files = (yield* git(coordinator, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean)
              if (!files.length || files.some((path) => !path.startsWith(policy.prefix))) return yield* invalid()
              const next = { ...checkpoint, conflictKind: 'source' as const, conflictIndex: index, resolutionTree: null }
              yield* saveArtifact(next)
              yield* sql.withTransaction(Effect.gen(function* () {
                yield* sql`UPDATE git_operations SET updated_at=${yield* now} WHERE id=${row.id} AND state='conflict'`
                yield* updateRunStates(next, 'conflict')
              }))
              return (yield* find(row.id))!
            }
          }
          const tree = (yield* git(coordinator, ['write-tree'])).trim()
          const patch = yield* git(coordinator, ['diff', '--binary', checkpoint.mainBase, tree, '--', policy.pathspec])
          yield* fs.writeFileString(resolutionPatchPath(row.id), patch, { mode: 0o600 })
          const target = yield* createTarget(checkpoint, tree)
          yield* sql.withTransaction(Effect.gen(function* () {
            yield* sql`UPDATE git_operations SET state='prepared', target_commit=${target}, updated_at=${yield* now}
              WHERE id=${row.id} AND state='conflict'`
            yield* updateRunStates(checkpoint, 'syncing')
          }))
          yield* removeCoordinator(row.id)
          return (yield* find(row.id))!
        })

        const resolveLocked = Effect.fn('TaskGitSynchronization.resolveLocked')(function* (id: string) {
          const row = yield* find(id)
          if (!row) return yield* new HarnessStoreError({ reason: 'not-found', message: 'Synchronization was not found.' })
          if (row.state !== 'conflict') return row
          const current = yield* conflictCheckout(row.taskId, id)
          return yield* finishConflict(row, current.value, current.coordinator)
        })

        const abortLocked = Effect.fn('TaskGitSynchronization.abortLocked')(function* (id: string) {
          const row = yield* find(id)
          if (!row) return yield* new HarnessStoreError({ reason: 'not-found', message: 'Synchronization was not found.' })
          if (row.state === 'aborted') return row
          if (!['pending', 'conflict', 'prepared'].includes(row.state)) return yield* invalid()
          const value = yield* artifact(row)
          yield* removeCoordinator(row.id)
          yield* sql.withTransaction(Effect.gen(function* () {
            yield* sql`UPDATE git_operations SET state='aborted', artifact_path=NULL, updated_at=${yield* now}
              WHERE id=${row.id} AND state IN ('pending', 'conflict', 'prepared')`
            yield* updateRunStates(value, 'failed')
          }))
          yield* fs.remove(operationFilePath(root, row.id).directory, { recursive: true }).pipe(Effect.catch(() => Effect.void))
          return (yield* find(row.id))!
        })

        const prepare = (input: typeof SynchronizeTaskWiki.Type) => withGitOperationGate(root, 'main',
          prepareLocked(input).pipe(Effect.provide(dependencies), Effect.map(receipt), Effect.mapError(storage)))
        const publish = (id: string) => withGitOperationGate(root, 'main',
          publishLocked(id).pipe(Effect.provide(dependencies), Effect.map(receipt), Effect.mapError(storage)))
        const align = (id: string) => withGitOperationGate(root, 'main',
          alignLocked(id).pipe(Effect.provide(dependencies), Effect.map(receipt), Effect.mapError(storage)))

        const synchronize = Effect.fn('TaskGitSynchronization.synchronize')(function* (input: typeof SynchronizeTaskWiki.Type) {
          let row = yield* prepare(input)
          if (row.state === 'conflict') return row
          row = yield* publish(row.id)
          if (row.state === 'conflict') return row
          return yield* align(row.id)
        }, Effect.mapError(storage))

        const reprepare = Effect.fn('TaskGitSynchronization.reprepare')(function* (input: typeof ReprepareTaskWiki.Type) {
          const value = yield* Schema.decodeUnknownEffect(ReprepareTaskWiki)(input, { onExcessProperty: 'error' })
          const old = yield* find(value.supersededId)
          if (!old || old.taskId !== value.taskId) return yield* new HarnessStoreError({ reason: 'not-found', message: 'Synchronization was not found.' })
          const sourceHead = old.sourceHead
          yield* withGitOperationGate(root, 'main', abortLocked(old.id).pipe(Effect.provide(dependencies)))
          return yield* synchronize({ id: value.id, taskId: value.taskId, expectedSourceHead: sourceHead })
        }, Effect.mapError(storage))

        const resolveConflict = Effect.fn('TaskGitSynchronization.resolve')(function* (id: string) {
          let row = yield* withGitOperationGate(root, 'main', resolveLocked(id).pipe(Effect.provide(dependencies)))
          if (row.state === 'conflict') return receipt(row)
          row = yield* withGitOperationGate(root, 'main', publishLocked(row.id).pipe(Effect.provide(dependencies)))
          if (row.state === 'conflict') return receipt(row)
          return receipt(yield* withGitOperationGate(root, 'main', alignLocked(row.id).pipe(Effect.provide(dependencies))))
        }, Effect.mapError(storage))

        const resolutionDirectory = (taskId: string, id: string) => conflictCheckout(taskId, id).pipe(
          Effect.provide(dependencies), Effect.map(({ coordinator }) => coordinator), Effect.mapError(storage)
        )
        const resolutionContext = (taskId: string, id: string) => conflictCheckout(taskId, id).pipe(
          Effect.provide(dependencies),
          Effect.flatMap(({ value, coordinator }) => Effect.gen(function* () {
            const index = value.conflictIndex
            const files = (yield* git(coordinator, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean)
            const sourceCommit = index === null ? undefined : value.sourceCommits[index]
            if (value.conflictKind === null || (value.conflictKind === 'source' && !sourceCommit)) return yield* invalid()
            const commonBase = value.conflictKind === 'source'
              ? (yield* git(coordinator, ['rev-parse', `${sourceCommit!}^`])).trim()
              : value.mainBase
            const canonicalDiff = yield* git(coordinator, ['--literal-pathspecs', 'diff', '--binary', commonBase, 'HEAD', '--', ...files])
            // An accepted resolution patch is already the complete Task-side input. Preserve it
            // verbatim when a later main conflicts; source conflicts can use their single commit.
            const taskDiff = value.conflictKind === 'source'
              ? yield* git(coordinator, ['--literal-pathspecs', 'diff', '--binary', commonBase, sourceCommit!, '--', ...files])
              : yield* fs.readFileString(resolutionPatchPath(id))
            return { directory: coordinator, files, commonBase, canonicalDiff, taskDiff }
          })),
          Effect.mapError(storage)
        )

        const acceptAgentResolution = Effect.fn('TaskGitSynchronization.acceptAgentResolution')(function* (taskId: string, id: string, runId: string) {
          const accepted = yield* sql`SELECT run.id FROM runs run JOIN sessions session
            ON session.id=run.session_id AND session.task_id=run.task_id
            WHERE run.id=${runId} AND run.task_id=${taskId} AND run.purpose='conflict-resolution'
              AND run.state='succeeded' AND session.sync_operation_id=${id}`
          if (!accepted.length) return yield* invalid()
          const current = yield* conflictCheckout(taskId, id)
          const policy = yield* taskPolicy(taskId)
          const paths = new Set<string>()
          for (const args of [['diff', '--name-only', '-z'], ['diff', '--cached', '--name-only', '-z'], ['ls-files', '--others', '--exclude-standard', '-z']] as const) {
            for (const path of (yield* git(current.coordinator, args)).split('\0').filter(Boolean)) paths.add(path)
          }
          if ([...paths].some((path) => !path.startsWith(policy.prefix))) return yield* invalid()
          yield* git(current.coordinator, ['add', '-A', '--', policy.pathspec])
          let row = yield* finishConflict(current.row, current.value, current.coordinator)
          row = yield* publishLocked(row.id)
          if (row.state === 'conflict') return receipt(row)
          return receipt(yield* alignLocked(row.id))
        }, Effect.provide(dependencies), effect => withGitOperationGate(root, 'main', effect), Effect.mapError(storage))

        const abort = (id: string) => withGitOperationGate(root, 'main',
          abortLocked(id).pipe(Effect.provide(dependencies), Effect.map(receipt), Effect.mapError(storage)))
        const get = Effect.fn('TaskGitSynchronization.get')(function* (id: string) {
          const row = yield* find(id)
          if (!row) return yield* new HarnessStoreError({ reason: 'not-found', message: 'Synchronization was not found.' })
          return receipt(row)
        }, Effect.mapError(storage))
        const pending = sql`SELECT sequence, id, task_id AS taskId, state, source_commit AS sourceHead,
          target_commit AS targetCommit, artifact_path AS artifactPath, created_at AS createdAt
          FROM git_operations WHERE kind='synchronize' AND state IN ('pending', 'conflict', 'prepared', 'published') ORDER BY sequence`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(OperationRow))),
          Effect.map((rows) => rows.map(receipt)),
          Effect.mapError(storage)
        )

        return TaskGitSynchronization.of({ prepare, publish, align, synchronize, reprepare, resolve: resolveConflict,
          resolutionDirectory, resolutionContext, acceptAgentResolution, abort, get, pending })
      }).pipe(Effect.mapError(storage))
    )
  }
}
