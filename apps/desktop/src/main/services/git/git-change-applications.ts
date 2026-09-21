import { Context, DateTime, Effect, FileSystem, Layer, Schema } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { ChildProcessSpawner } from 'effect/unstable/process'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import {
  ConfirmRunWikiUnchanged,
  GitChangeApplication,
  GitObjectId,
  SaveGitFiles,
  SaveRunWikiFiles,
  SaveTaskRawFiles,
  type ConfirmRunWikiUnchanged as ConfirmRunWikiUnchangedValue,
  type SaveGitFiles as SaveGitFilesValue,
  type SaveRunWikiFiles as SaveRunWikiFilesValue,
  type SaveTaskRawFiles as SaveTaskRawFilesValue
} from '../../../shared/git-change'
import { HarnessStoreError, type RunRecord } from '../../../shared/harness'
import { HarnessStore } from '../harness/harness-store'
import { gitCommitData, gitCommitHash } from './git-commit-object'
import { operationFilePath, readSaveOperationFile, SaveOperationFile, writeSaveOperationFile } from './git-operation-files'
import { withGitOperationGate } from './git-operation-gate'
import { snapshotGitChange } from './git-change-snapshot'
import { makeVaultGit } from './vault-git'

const OperationRow = Schema.Struct({
  id: Schema.String,
  taskId: Schema.NullOr(Schema.String),
  kind: Schema.Literals(['save-user', 'save-raws', 'save-wiki']),
  state: Schema.Literals(['pending', 'completed']),
  sourceCommit: GitObjectId,
  targetCommit: Schema.NullOr(GitObjectId),
  artifactPath: Schema.NullOr(Schema.String),
  createdAt: Schema.Int
})
type OperationRow = typeof OperationRow.Type
type SaveRequest =
  | (SaveGitFilesValue & { readonly kind: 'user'; readonly runIds: readonly [] })
  | (SaveRunWikiFilesValue & { readonly kind: 'wiki' })
  | (SaveTaskRawFilesValue & { readonly kind: 'raws'; readonly runIds: readonly [] })

const invalid = () => new HarnessStoreError({ reason: 'invalid-state', message: 'Git save state changed. Review the workspace before retrying.' })
const storage = (cause: unknown) =>
  cause instanceof HarnessStoreError
    ? cause
    : new HarnessStoreError({ reason: 'storage', message: 'Could not finish the Git save. Its local recovery file was retained.' })
const operationKind = (kind: SaveOperationFile['kind']) => `save-${kind}` as const

/** A commit is registered only after its branch or synchronization receipt reached completion. */
export const isRegisteredGitCommit = Effect.fn('GitChange.isRegisteredCommit')(function* (branch: string, commit: string, base: string) {
  if (commit === base) return true
  const sql = yield* SqlClient.SqlClient
  if (branch === 'main') {
    return (yield* sql`SELECT id FROM git_operations WHERE target_commit=${commit}
      AND state IN ('published', 'completed')
      AND ((task_id IS NULL AND kind='save-user') OR kind='synchronize') LIMIT 1`).length === 1
  }
  const taskId = branch.startsWith('folio/task/') ? branch.slice('folio/task/'.length) : ''
  if (!taskId) return false
  return (yield* sql`SELECT id FROM git_operations WHERE task_id=${taskId} AND target_commit=${commit}
    AND state='completed' LIMIT 1`).length === 1
})

/** Saves selected files as one compact operation without persisting commit bytes or index images. */
export class GitChangeApplications extends Context.Service<
  GitChangeApplications,
  {
    readonly editWorkspace: <A>(edit: Effect.Effect<{ readonly value: A; readonly paths: readonly string[] }, HarnessStoreError>) => Effect.Effect<A, HarnessStoreError>
    readonly save: (input: SaveGitFiles) => Effect.Effect<GitChangeApplication, HarnessStoreError>
    readonly saveRunWiki: (input: SaveRunWikiFilesValue) => Effect.Effect<GitChangeApplication, HarnessStoreError>
    readonly saveTaskRaws: (input: SaveTaskRawFilesValue) => Effect.Effect<GitChangeApplication, HarnessStoreError>
    readonly confirmRunWikiUnchanged: (input: ConfirmRunWikiUnchangedValue) => Effect.Effect<RunRecord, HarnessStoreError>
    readonly apply: (id: string) => Effect.Effect<GitChangeApplication, HarnessStoreError>
    readonly recover: (id: string) => Effect.Effect<GitChangeApplication, HarnessStoreError>
    readonly pending: Effect.Effect<readonly GitChangeApplication[], HarnessStoreError>
  }
>()('folio/services/GitChangeApplications') {
  static layer(directory: string) {
    return Layer.effect(
      GitChangeApplications,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const sql = yield* SqlClient.SqlClient
        const store = yield* HarnessStore
        const git = yield* makeVaultGit
        const dependencies = yield* Effect.context<FileSystem.FileSystem | SqlClient.SqlClient | ChildProcessSpawner.ChildProcessSpawner>()
        const root = yield* fs.realPath(directory)
        const main = join(root, 'workspace')

        const find = Effect.fn('GitChangeApplications.find')(function* (id: string) {
          const rows = yield* sql`SELECT id, task_id AS taskId, kind, state, source_commit AS sourceCommit,
            target_commit AS targetCommit, artifact_path AS artifactPath, created_at AS createdAt
            FROM git_operations WHERE id=${id} AND kind IN ('save-user', 'save-raws', 'save-wiki')`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(OperationRow)))
          )
          return rows[0]
        })

        /** Verifies Folio's checkout identity and refuses active Runs or native Git operations. */
        const checkout = Effect.fn('GitChangeApplications.checkout')(function* (taskId: string | null) {
          const marker = yield* fs.readFileString(join(main, '.git', 'folio-workspace.json')).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ version: Schema.Literal(1), initialCommit: GitObjectId }))))
          )
          let path = main
          let branch = 'main'
          let base = marker.initialCommit
          if (taskId !== null) {
            const task = yield* store.task(taskId)
            path = join(root, 'worktrees', taskId)
            branch = `folio/task/${taskId}`
            if (task.state !== 'active' || task.worktreeState !== 'ready' || task.worktreeBase === null) return yield* invalid()
            if ((yield* store.runs(taskId)).some((run) => run.state === 'preparing' || run.state === 'running')) return yield* invalid()
            base = task.worktreeBase
          }
          if (
            (yield* fs.realPath(path)) !== path ||
            (yield* git(path, ['rev-parse', '--show-toplevel'])).trim() !== path ||
            (yield* git(path, ['symbolic-ref', 'HEAD'])).trim() !== `refs/heads/${branch}` ||
            (taskId !== null && (yield* fs.realPath(resolve(path, (yield* git(path, ['rev-parse', '--git-common-dir'])).trim()))) !== join(main, '.git'))
          ) return yield* invalid()
          const gitDirectory = (yield* git(path, ['rev-parse', '--absolute-git-dir'])).trim()
          for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
            if (yield* fs.exists(join(gitDirectory, name))) return yield* invalid()
          }
          return { path, branch, base }
        })

        const receipt = (row: OperationRow): GitChangeApplication => ({
          id: row.id,
          branch: row.taskId === null ? 'main' : `folio/task/${row.taskId}`,
          commit: row.targetCommit!,
          state: row.state === 'completed' ? 'completed' : 'pending'
        })

        /** Computes the selected-path index transition without writing the checkout's real index. */
        const indexTransition = Effect.fn('GitChangeApplications.indexTransition')(
          function* (path: string, tree: string, paths: readonly string[]) {
            const before = yield* Schema.decodeUnknownEffect(GitObjectId)((yield* git(path, ['write-tree'])).trim())
            const temporary = yield* fs.makeTempDirectoryScoped({ prefix: 'folio-save-index-' })
            const options = { indexFile: join(temporary, 'index') }
            yield* git(path, ['read-tree', before], options)
            yield* git(path, ['--literal-pathspecs', 'reset', tree, '--', ...paths], options)
            const after = yield* Schema.decodeUnknownEffect(GitObjectId)((yield* git(path, ['write-tree'], options)).trim())
            return { before, after }
          },
          Effect.scoped
        )

        /** Recreates the deterministic object from the local file, then advances one branch by CAS. */
        const completeLocked = Effect.fn('GitChangeApplications.completeLocked')(function* (row: OperationRow) {
          if (row.state === 'completed' && row.targetCommit) return receipt(row)
          if (row.state !== 'pending' || !row.artifactPath || !row.targetCommit) return yield* invalid()
          const artifact = yield* readSaveOperationFile(root, row.artifactPath)
          if (
            artifact.id !== row.id || artifact.taskId !== row.taskId || operationKind(artifact.kind) !== row.kind ||
            artifact.parent !== row.sourceCommit || artifact.commit !== row.targetCommit
          ) return yield* invalid()
          const format = yield* Schema.decodeUnknownEffect(Schema.Literals(['sha1', 'sha256']))((yield* git(main, ['rev-parse', '--show-object-format'])).trim())
          const data = gitCommitData({
            tree: artifact.tree,
            parent: artifact.parent,
            createdAt: artifact.createdAt,
            message: `Save ${artifact.kind} changes\n\nFolio-Operation-Id: ${artifact.id}\n` +
              (artifact.taskId === null ? '' : `Folio-Task-Id: ${artifact.taskId}\n`) +
              artifact.runIds.map((runId) => `Folio-Run-Id: ${runId}\n`).join('')
          })
          if (gitCommitHash(data, format) !== artifact.commit) return yield* invalid()
          if ((yield* git(main, ['hash-object', '-t', 'commit', '-w', '--stdin'], { input: data })).trim() !== artifact.commit) return yield* invalid()
          const ref = `refs/folio/operations/${artifact.id}`
          const retained = (yield* git(main, ['for-each-ref', '--format=%(objectname)', ref])).trim()
          if (retained && retained !== artifact.commit) return yield* invalid()
          if (!retained) yield* git(main, ['update-ref', '--no-deref', ref, artifact.commit, '0'.repeat(artifact.commit.length)])

          const source = yield* checkout(artifact.taskId)
          const head = (yield* git(source.path, ['rev-parse', 'HEAD'])).trim()
          if (head !== artifact.parent && head !== artifact.commit) return yield* invalid()
          let indexTree = yield* Schema.decodeUnknownEffect(GitObjectId)((yield* git(source.path, ['write-tree'])).trim())
          if (head === artifact.parent) {
            if (indexTree !== artifact.beforeIndexTree) return yield* invalid()
            yield* git(source.path, ['update-ref', '--no-deref', '-m', `Folio save ${artifact.id}`,
              `refs/heads/${source.branch}`, artifact.commit, artifact.parent])
          }
          // Update only selected index entries. Unselected staging is user state and must survive
          // both the initial save and a crash after the branch ref moved.
          if (indexTree === artifact.beforeIndexTree) {
            yield* git(source.path, ['--literal-pathspecs', 'reset', artifact.commit, '--', ...artifact.paths])
            indexTree = yield* Schema.decodeUnknownEffect(GitObjectId)((yield* git(source.path, ['write-tree'])).trim())
          }
          if (indexTree !== artifact.afterIndexTree) return yield* invalid()
          if ((yield* git(source.path, ['rev-parse', 'HEAD'])).trim() !== artifact.commit) return yield* invalid()
          const changed = yield* sql`UPDATE git_operations SET state='completed', artifact_path=NULL,
            updated_at=${DateTime.toEpochMillis(yield* DateTime.now)} WHERE id=${artifact.id} AND state='pending' RETURNING id`
          const current = yield* find(artifact.id)
          if (!current || (!changed.length && current.state !== 'completed')) return yield* invalid()
          yield* fs.remove(operationFilePath(root, artifact.id).directory, { recursive: true }).pipe(Effect.catch(() => Effect.void))
          return receipt(current)
        })

        const recoverLocked = Effect.fn('GitChangeApplications.recoverLocked')(function* (id: string) {
          const row = yield* find(id)
          if (!row) return yield* new HarnessStoreError({ reason: 'not-found', message: 'Git save operation was not found.' })
          return yield* completeLocked(row)
        })

        /** Captures selected paths with a private index, then stores only compact recovery metadata. */
        const saveLocked = Effect.fn('GitChangeApplications.saveLocked')(function* (value: SaveRequest) {
          const previous = yield* find(value.id)
          if (previous) {
            if (previous.taskId !== value.taskId || previous.kind !== operationKind(value.kind) ||
              previous.sourceCommit !== value.expectedParent || !previous.targetCommit) return yield* invalid()
            if (previous.state === 'completed') {
              const paths = (yield* git(main, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z',
                previous.sourceCommit, previous.targetCommit])).split('\0').filter(Boolean).sort()
              const owners = (yield* sql<{ runId: string }>`SELECT run_id AS runId FROM git_operation_runs
                WHERE operation_id=${previous.id} ORDER BY run_id`).map((row) => row.runId)
              if (JSON.stringify(paths) !== JSON.stringify(value.paths) ||
                JSON.stringify(owners) !== JSON.stringify(value.runIds)) return yield* invalid()
              return receipt(previous)
            }
            if (!previous.artifactPath) return yield* invalid()
            if (previous.artifactPath) {
              const artifact = yield* readSaveOperationFile(root, previous.artifactPath)
              if (artifact.taskId !== value.taskId || artifact.kind !== value.kind || artifact.parent !== value.expectedParent ||
                JSON.stringify(artifact.paths) !== JSON.stringify(value.paths) || JSON.stringify(artifact.runIds) !== JSON.stringify(value.runIds)) return yield* invalid()
            }
            return yield* completeLocked(previous)
          }
          const source = yield* checkout(value.taskId)
          const parent = (yield* git(source.path, ['rev-parse', 'HEAD'])).trim()
          if (parent !== value.expectedParent || !(yield* isRegisteredGitCommit(source.branch, parent, source.base))) return yield* invalid()
          if ((yield* sql`SELECT id FROM git_operations WHERE task_id IS ${value.taskId}
            AND state IN ('pending', 'conflict', 'prepared', 'published')`).length) return yield* invalid()
          if (value.kind === 'wiki') {
            const runs = yield* store.runs(value.taskId)
            if (value.runIds.some((runId) => {
              const run = runs.find((candidate) => candidate.id === runId)
              return !run || run.state !== 'succeeded' || !['pending', 'failed'].includes(run.syncState)
            })) return yield* invalid()
            for (const runId of value.runIds) {
              if ((yield* sql`SELECT run_id FROM git_operation_runs WHERE run_id=${runId}`).length) return yield* invalid()
            }
          }
          const snapshot = yield* snapshotGitChange({ cwd: source.path, parent, paths: value.paths })
          if (snapshot.changed.length !== value.paths.length) return yield* invalid()
          const index = yield* indexTransition(source.path, snapshot.tree, value.paths)
          const createdAt = DateTime.toEpochMillis(yield* DateTime.now)
          const data = gitCommitData({
            tree: snapshot.tree,
            parent,
            createdAt,
            message: `Save ${value.kind} changes\n\nFolio-Operation-Id: ${value.id}\n` +
              (value.taskId === null ? '' : `Folio-Task-Id: ${value.taskId}\n`) +
              value.runIds.map((runId) => `Folio-Run-Id: ${runId}\n`).join('')
          })
          const format = yield* Schema.decodeUnknownEffect(Schema.Literals(['sha1', 'sha256']))((yield* git(main, ['rev-parse', '--show-object-format'])).trim())
          const commit = gitCommitHash(data, format)
          const artifact: SaveOperationFile = { version: 1, id: value.id, taskId: value.taskId, kind: value.kind,
            runIds: value.runIds, parent, tree: snapshot.tree, paths: value.paths, commit,
            beforeIndexTree: index.before, afterIndexTree: index.after, createdAt }
          const artifactPath = yield* writeSaveOperationFile(root, artifact)
          yield* sql.withTransaction(Effect.gen(function* () {
            yield* sql`INSERT INTO git_operations
              (id, task_id, kind, state, source_commit, target_commit, artifact_path, created_at, updated_at)
              VALUES (${value.id}, ${value.taskId}, ${operationKind(value.kind)}, 'pending', ${parent}, ${commit},
                ${artifactPath}, ${createdAt}, ${createdAt})`
            for (const runId of value.runIds) yield* sql`INSERT INTO git_operation_runs (operation_id, run_id) VALUES (${value.id}, ${runId})`
          }))
          return yield* recoverLocked(value.id)
        })

        const normalizePaths = <A extends { readonly paths: readonly string[] }>(value: A) => ({ ...value, paths: [...new Set(value.paths)].sort() })
        const save = Effect.fn('GitChangeApplications.save')(function* (input: SaveGitFilesValue) {
          const decoded = yield* Schema.decodeUnknownEffect(SaveGitFiles)(input, { onExcessProperty: 'error' })
          return yield* saveLocked({ ...normalizePaths(decoded), kind: 'user', runIds: [] })
        }, Effect.provide(dependencies), Effect.mapError(storage))
        const saveRunWiki = Effect.fn('GitChangeApplications.saveRunWiki')(function* (input: SaveRunWikiFilesValue) {
          const decoded = yield* Schema.decodeUnknownEffect(SaveRunWikiFiles)(input, { onExcessProperty: 'error' })
          return yield* saveLocked({ ...normalizePaths(decoded), runIds: [...new Set(decoded.runIds)].sort() as [string, ...string[]], kind: 'wiki' })
        }, Effect.provide(dependencies), Effect.mapError(storage))
        const saveTaskRaws = Effect.fn('GitChangeApplications.saveTaskRaws')(function* (input: SaveTaskRawFilesValue) {
          const decoded = yield* Schema.decodeUnknownEffect(SaveTaskRawFiles)(input, { onExcessProperty: 'error' })
          return yield* saveLocked({ ...normalizePaths(decoded), kind: 'raws', runIds: [] })
        }, Effect.provide(dependencies), Effect.mapError(storage))

        const gateKey = (taskId: string | null) => taskId === null ? 'main' : `task:${taskId}`
        const runSave = <A, R>(taskId: string | null, effect: Effect.Effect<A, HarnessStoreError, R>) =>
          withGitOperationGate(root, gateKey(taskId), effect)

        const editWorkspace = <A>(edit: Effect.Effect<{ readonly value: A; readonly paths: readonly string[] }, HarnessStoreError>) =>
          runSave(null, Effect.gen(function* () {
            const source = yield* checkout(null)
            const expectedParent = (yield* git(source.path, ['rev-parse', 'HEAD'])).trim()
            const { value, paths } = yield* edit
            const selected = [...new Set(paths)].sort()
            if (selected.length && (yield* git(source.path, ['status', '--porcelain', '--untracked-files=all', '--', ...selected])).trim()) {
              yield* saveLocked({ id: randomUUID(), taskId: null, expectedParent, paths: selected as [string, ...string[]], kind: 'user', runIds: [] })
            }
            return value
          }).pipe(Effect.provide(dependencies), Effect.mapError(storage)))

        const confirmRunWikiUnchanged = (input: ConfirmRunWikiUnchangedValue) => runSave(input.taskId, Effect.gen(function* () {
          const value = yield* Schema.decodeUnknownEffect(ConfirmRunWikiUnchanged)(input, { onExcessProperty: 'error' })
          let run = (yield* store.runs(value.taskId)).find((candidate) => candidate.id === value.runId)
          if (!run || run.state !== 'succeeded' || run.baselineCommit !== value.expectedHead) return yield* invalid()
          if (run.syncState === 'not-required') return run
          if (run.syncState !== 'pending') return yield* invalid()
          const source = yield* checkout(value.taskId)
          if ((yield* git(source.path, ['rev-parse', 'HEAD'])).trim() !== value.expectedHead ||
            (yield* git(source.path, ['diff', '--name-only', '-z', value.expectedHead, '--', 'wiki'])) ||
            (yield* git(source.path, ['ls-files', '--others', '--exclude-standard', '-z', '--', 'wiki']))) return yield* invalid()
          yield* sql`UPDATE runs SET sync_state='not-required' WHERE id=${value.runId} AND sync_state='pending'`
          run = (yield* store.runs(value.taskId)).find((candidate) => candidate.id === value.runId)
          if (!run) return yield* invalid()
          return run
        }).pipe(Effect.provide(dependencies), Effect.mapError(storage)))

        const recover = (id: string) => Effect.gen(function* () {
          const row = yield* find(id)
          if (!row) return yield* new HarnessStoreError({ reason: 'not-found', message: 'Git save operation was not found.' })
          return yield* runSave(row.taskId, completeLocked(row).pipe(Effect.provide(dependencies), Effect.mapError(storage)))
        }).pipe(Effect.mapError(storage))
        const pending = Effect.gen(function* () {
          const rows = yield* sql`SELECT id, task_id AS taskId, kind, state, source_commit AS sourceCommit,
            target_commit AS targetCommit, artifact_path AS artifactPath, created_at AS createdAt
            FROM git_operations WHERE kind IN ('save-user', 'save-raws', 'save-wiki') AND state='pending' ORDER BY sequence`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(OperationRow)))
          )
          return rows.map(receipt)
        }).pipe(Effect.mapError(storage))

        return GitChangeApplications.of({
          editWorkspace,
          save: (input) => runSave(input.taskId, save(input)),
          saveRunWiki: (input) => runSave(input.taskId, saveRunWiki(input)),
          saveTaskRaws: (input) => runSave(input.taskId, saveTaskRaws(input)),
          confirmRunWikiUnchanged,
          apply: recover,
          recover,
          pending
        })
      }).pipe(Effect.mapError(storage))
    )
  }
}
