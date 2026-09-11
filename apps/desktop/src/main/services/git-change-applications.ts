import { Context, Effect, FileSystem, Layer, Schema } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { ChildProcessSpawner } from 'effect/unstable/process'
import { link, lstat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  ConfirmRunWikiUnchanged,
  GitChangeApplication,
  GitChangeIntent,
  GitObjectId,
  SaveGitFiles,
  SaveRunWikiFiles,
  type GitChangePreparation,
  type ConfirmRunWikiUnchanged as ConfirmRunWikiUnchangedValue,
  type SaveGitFiles as SaveGitFilesValue,
  type SaveRunWikiFiles as SaveRunWikiFilesValue
} from '../../shared/git-change'
import { HarnessStoreError, type RunRecord } from '../../shared/harness'
import { GitChangeJournal } from './git-change-journal'
import { prepareSaveIndex, savedIndexTree } from './git-save-index'
import { HarnessStore } from './harness-store'
import { makeVaultGit } from './vault-git'
import { VaultGitWriteLock } from './vault-git-write-lock'
import { snapshotGitChange } from './git-change-snapshot'

const Row = Schema.Struct({ ...GitChangeApplication.fields, before: Schema.Uint8Array, after: Schema.Uint8Array })
type Row = typeof Row.Type
const RunOwnerRow = Schema.Struct({ runId: Schema.String })
type SaveRequest = (SaveGitFilesValue & { readonly kind: 'user'; readonly runIds: readonly [] }) | (SaveRunWikiFilesValue & { readonly kind: 'wiki' })
const existsError = Schema.is(Schema.Struct({ code: Schema.Literal('EEXIST') }))
const invalid = () => new HarnessStoreError({ reason: 'invalid-state', message: 'Git save state changed. Its files and journal have been retained for inspection.' })
const storage = (cause: unknown) =>
  cause instanceof HarnessStoreError ? cause : new HarnessStoreError({ reason: 'storage', message: 'Could not apply the saved change. Inspect or retry its recorded operation.' })
const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b))

/** A prepared object alone never registers a source baseline. The caller supplies a verified bootstrap/base. */
export const isRegisteredGitCommit = Effect.fn('GitChange.isRegisteredCommit')(function* (branch: string, commit: string, base: string) {
  if (commit === base) return true
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT a.id FROM git_change_applications a JOIN git_change_preparations p ON p.id=a.id
    WHERE a.branch=${branch} AND a.state='applied' AND p.commit_oid=${commit}`
  if (rows.length === 1) return true
  if (branch === 'main') {
    return (
      (yield* sql`SELECT id FROM git_sync_operations WHERE published_head=${commit}
      AND state IN ('published', 'aligning', 'aligned') LIMIT 1`).length === 1
    )
  }
  return (
    (yield* sql`SELECT s.id FROM git_sync_operations s JOIN tasks t ON t.id=s.task_id
    WHERE t.branch=${branch} AND s.aligned_head=${commit} AND s.state='aligned' LIMIT 1`).length === 1
  )
})

/**
 * Applies a retained save to its original branch without writing working files. It journals both
 * index versions before any branch write. Pending saves block new Runs in SQLite; native writer
 * quiescence remains the caller's separate obligation and is not inferred from a terminal Run.
 */
export class GitChangeApplications extends Context.Service<
  GitChangeApplications,
  {
    readonly save: (input: SaveGitFiles) => Effect.Effect<GitChangeApplication, HarnessStoreError>
    readonly saveRunWiki: (input: SaveRunWikiFilesValue) => Effect.Effect<GitChangeApplication, HarnessStoreError>
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
        const dependencies = yield* Effect.context<FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | SqlClient.SqlClient>()
        const sql = yield* SqlClient.SqlClient
        const store = yield* HarnessStore
        const journal = yield* GitChangeJournal
        const lock = yield* VaultGitWriteLock
        const git = yield* makeVaultGit
        const root = yield* fs.realPath(directory)
        const main = join(root, 'workspace')

        /** Reads persisted index bytes; the payload is never exposed in the application receipt. */
        const find = Effect.fn('GitChangeApplications.find')(function* (id: string) {
          yield* Schema.decodeUnknownEffect(GitChangeIntent.fields.id)(id)
          const rows = yield* sql`SELECT a.id, a.branch, p.commit_oid AS "commit", a.state,
          a.before_index AS before, a.after_index AS after
          FROM git_change_applications a JOIN git_change_preparations p ON p.id=a.id WHERE a.id=${id}`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Row))))
          return rows[0]
        })

        /** Rejects redirected/missing indexes instead of treating them as an empty staging area. */
        const readIndex = Effect.fn('GitChangeApplications.readIndex')(function* (path: string) {
          const info = yield* Effect.tryPromise(() => lstat(path))
          if (!info.isFile() || info.isSymbolicLink()) return yield* invalid()
          return yield* fs.readFile(path)
        })

        /** Verifies source identity and refuses another unfinished native Git operation. */
        const checkout = Effect.fn('GitChangeApplications.checkout')(function* (change: Pick<GitChangePreparation, 'taskId' | 'branch'>) {
          let path = main
          const marker = yield* fs
            .readFileString(join(main, '.git/folio-workspace.json'))
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ version: Schema.Literal(1), initialCommit: GitObjectId })))))
          let base = marker.initialCommit
          if (change.taskId !== null) {
            const task = yield* store.task(change.taskId)
            path = join(root, 'worktrees', change.taskId)
            if (
              task.state !== 'active' ||
              task.worktreeState !== 'ready' ||
              task.worktree !== path ||
              task.branch !== change.branch ||
              task.worktreeBase === null ||
              !(yield* isRegisteredGitCommit('main', task.worktreeBase, marker.initialCommit))
            )
              return yield* invalid()
            base = task.worktreeBase
            if ((yield* store.runs(change.taskId)).some((run) => run.state === 'preparing' || run.state === 'running')) return yield* invalid()
            if (
              (yield* sql`SELECT id FROM git_sync_operations WHERE task_id=${change.taskId}
            AND state IN ('preparing', 'conflict', 'resolving', 'prepared', 'aligning')`).length
            )
              return yield* invalid()
          }
          if (
            (yield* fs.realPath(path)) !== path ||
            (yield* git(path, ['rev-parse', '--show-toplevel'])).trim() !== path ||
            (yield* fs.realPath(resolve(path, (yield* git(path, ['rev-parse', '--git-common-dir'])).trim()))) !== join(main, '.git') ||
            (yield* git(path, ['symbolic-ref', 'HEAD'])).trim() !== `refs/heads/${change.branch}`
          )
            return yield* invalid()
          const gitDir = yield* fs.realPath((yield* git(path, ['rev-parse', '--absolute-git-dir'])).trim())
          const index = (yield* git(path, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim()
          if (index !== join(gitDir, 'index')) return yield* invalid()
          for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
            if (yield* fs.exists(join(gitDir, name))) return yield* invalid()
          }
          return { path, index, base }
        })

        /** Reserves the exact old/new index bytes before acquiring index.lock or moving a ref. */
        const reserve = Effect.fn('GitChangeApplications.reserve')(function* (change: GitChangePreparation) {
          const previous = yield* find(change.id)
          if (previous) return previous
          const source = yield* checkout(change)
          if ((yield* git(source.path, ['rev-parse', 'HEAD'])).trim() !== change.parent || !(yield* isRegisteredGitCommit(change.branch, change.parent, source.base)))
            return yield* invalid()
          const before = yield* readIndex(source.index)
          const after = yield* prepareSaveIndex(source.path, before, change)
          yield* sql`INSERT INTO git_change_applications (id, branch, before_index, after_index, state)
          VALUES (${change.id}, ${change.branch}, ${before}, ${after}, 'applying') ON CONFLICT(id) DO NOTHING`
          const row = yield* find(change.id)
          if (!row) return yield* invalid()
          return row
        })

        /**
         * Atomically publishes immutable staged bytes. Hard-link identity proves ownership of a
         * surviving index.lock after a crash; an unrelated lock is never removed or overwritten.
         */
        const stageIndex = Effect.fn('GitChangeApplications.stageIndex')(function* (index: string, row: Row) {
          const folder = join(dirname(index), 'folio-save-indexes')
          yield* fs.makeDirectory(folder, { recursive: true })
          if ((yield* fs.realPath(folder)) !== folder) return yield* invalid()
          const staged = join(folder, row.id)
          const temporary = yield* fs.makeTempDirectoryScoped({ directory: folder, prefix: '.prepare-' })
          const file = join(temporary, 'index')
          yield* fs.writeFile(file, row.after, { mode: 0o600 })
          yield* Effect.tryPromise(() =>
            link(file, staged).catch((error) => {
              if (!existsError(error)) throw error
            })
          )
          if (!sameBytes(yield* readIndex(staged), row.after)) return yield* invalid()
          return staged
        }, Effect.scoped)

        /** Complete the two Git writes under the separate process-owned Vault gate, then save the receipt. */
        const publish = Effect.fn('GitChangeApplications.publish')(function* (change: GitChangePreparation, row: Row) {
          if (row.state === 'applied') return row
          const source = yield* checkout(change)
          const staged = yield* stageIndex(source.index, row)
          const indexLock = `${source.index}.lock`
          yield* Effect.tryPromise(() =>
            link(staged, indexLock).catch((error) => {
              if (!existsError(error)) throw error
            })
          )
          const ownsLock = Effect.fn('GitChangeApplications.ownsIndexLock')(function* () {
            const a = yield* Effect.tryPromise(() => lstat(staged))
            const b = yield* Effect.tryPromise(() => lstat(indexLock))
            return a.isFile() && b.isFile() && !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino
          })
          if (!(yield* ownsLock()) || !sameBytes(yield* readIndex(indexLock), row.after)) return yield* invalid()
          const current = yield* readIndex(source.index)
          const head = (yield* git(source.path, ['rev-parse', 'HEAD'])).trim()
          const ref = `refs/heads/${change.branch}`
          if (
            (yield* git(source.path, ['for-each-ref', '--format=%(refname) %(objectname) %(symref)', ref])).trim() !== `${ref} ${head}` ||
            (head !== change.parent && head !== change.commit)
          )
            return yield* invalid()
          let keepCurrentIndex = head === change.commit && sameBytes(current, row.after)
          if (!sameBytes(current, row.before) && !keepCurrentIndex) {
            // Git status may refresh stat/cache data after a successful save whose receipt was lost.
            // Accept identical staged content without overwriting that newer index or its flags.
            if (head !== change.commit || (yield* savedIndexTree(source.path, current)) !== (yield* savedIndexTree(source.path, row.after))) return yield* invalid()
            keepCurrentIndex = true
          }
          if (head === change.parent) {
            // A surviving Git child from a dead owner can only attempt this same CAS, never force a newer HEAD back.
            yield* git(source.path, ['update-ref', '--no-deref', '-m', `Folio save ${change.id}`, ref, change.commit, change.parent]).pipe(
              Effect.catch((error) => git(source.path, ['rev-parse', ref]).pipe(Effect.flatMap((actual) => (actual.trim() === change.commit ? Effect.void : Effect.fail(error)))))
            )
          }
          if ((yield* git(source.path, ['rev-parse', 'HEAD'])).trim() !== change.commit || !(yield* ownsLock())) return yield* invalid()
          // Rename publishes the complete index atomically; no working file is restored or overwritten.
          if (keepCurrentIndex) yield* fs.remove(indexLock)
          else yield* fs.rename(indexLock, source.index)
          if (!sameBytes(yield* readIndex(source.index), keepCurrentIndex ? current : row.after)) return yield* invalid()
          yield* sql`UPDATE git_change_applications SET state='applied' WHERE id=${row.id}`
          return { ...row, state: 'applied' as const }
        })

        /** Called only while the outer operation owns the Vault gate; receipts never reapply an old commit. */
        const applyLocked = Effect.fn('GitChangeApplications.applyLocked')(
          function* (id: string) {
            const previous = yield* find(id)
            if (previous?.state === 'applied') {
              const { before: _, after: __, ...receipt } = previous
              return receipt
            }
            const change = yield* journal.recover(id)
            const result = yield* publish(change, yield* reserve(change))
            const { before: _, after: __, ...receipt } = result
            return receipt
          },
          Effect.provide(dependencies),
          Effect.mapError(storage)
        )

        /** Captures one explicit selection; user edits and accepted Run output keep distinct provenance. */
        const saveLocked = Effect.fn('GitChangeApplications.saveLocked')(function* (value: SaveRequest) {
          const previous = yield* journal.get(value.id).pipe(Effect.catch((error) => (error.reason === 'not-found' ? Effect.succeed(null) : Effect.fail(error))))
          if (previous) {
            if (
              previous.kind !== value.kind ||
              JSON.stringify(previous.runIds) !== JSON.stringify(value.runIds) ||
              previous.taskId !== value.taskId ||
              previous.parent !== value.expectedParent ||
              JSON.stringify(previous.paths) !== JSON.stringify(value.paths)
            )
              return yield* invalid()
            return yield* applyLocked(value.id)
          }
          if (value.kind === 'wiki') {
            const runs = yield* store.runs(value.taskId)
            if (
              value.runIds.some((runId) => {
                const run = runs.find((candidate) => candidate.id === runId)
                return !run || run.state !== 'succeeded' || (run.syncState !== 'pending' && run.syncState !== 'failed')
              })
            )
              return yield* invalid()
            const owners = yield* sql`SELECT run_id AS runId FROM git_change_preparation_runs
              WHERE task_id=${value.taskId} AND kind='wiki'`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(RunOwnerRow))))
            if (owners.some((owner) => value.runIds.includes(owner.runId))) return yield* invalid()
          }
          const branch = value.taskId === null ? 'main' : `folio/task/${value.taskId}`
          const source = yield* checkout({ taskId: value.taskId, branch })
          const pendingSave = yield* sql`SELECT id FROM git_change_applications WHERE branch=${branch} AND state='applying'`
          if (pendingSave.length || !(yield* isRegisteredGitCommit(branch, value.expectedParent, source.base))) return yield* invalid()
          const snapshot = yield* snapshotGitChange({ cwd: source.path, parent: value.expectedParent, paths: value.paths })
          yield* journal.prepare({ id: value.id, taskId: value.taskId, runIds: value.runIds, kind: value.kind, parent: snapshot.parent, tree: snapshot.tree, paths: value.paths })
          return yield* applyLocked(value.id)
        })

        /** Holds one gate across user save capture, durable preparation and application. */
        const save = Effect.fn('GitChangeApplications.save')(
          function* (input: SaveGitFiles) {
            const decoded = yield* Schema.decodeUnknownEffect(SaveGitFiles)(input, { onExcessProperty: 'error' })
            const value = yield* Schema.decodeUnknownEffect(SaveGitFiles)({ ...decoded, paths: [...new Set(decoded.paths)].sort() })
            return yield* saveLocked({ ...value, kind: 'user', runIds: [] })
          },
          Effect.provide(dependencies),
          Effect.mapError(storage),
          lock.withLock
        )

        /** User-triggered Run save records Agent provenance without inferring filesystem ownership. */
        const saveRunWiki = Effect.fn('GitChangeApplications.saveRunWiki')(
          function* (input: SaveRunWikiFilesValue) {
            const decoded = yield* Schema.decodeUnknownEffect(SaveRunWikiFiles)(input, { onExcessProperty: 'error' })
            const value = yield* Schema.decodeUnknownEffect(SaveRunWikiFiles)({
              ...decoded,
              runIds: [...new Set(decoded.runIds)].sort(),
              paths: [...new Set(decoded.paths)].sort()
            })
            return yield* saveLocked({ ...value, kind: 'wiki' })
          },
          Effect.provide(dependencies),
          Effect.mapError(storage),
          lock.withLock
        )

        /** Records explicit acceptance only while the observed Run baseline still has no wiki delta. */
        const confirmRunWikiUnchanged = Effect.fn('GitChangeApplications.confirmRunWikiUnchanged')(
          function* (input: ConfirmRunWikiUnchangedValue) {
            const value = yield* Schema.decodeUnknownEffect(ConfirmRunWikiUnchanged)(input, { onExcessProperty: 'error' })
            let run = (yield* store.runs(value.taskId)).find((candidate) => candidate.id === value.runId)
            if (!run || run.state !== 'succeeded' || run.baselineCommit !== value.expectedHead) return yield* invalid()
            // The Run row is the durable receipt; retry stays read-only even after Task release.
            if (run.syncState === 'not-required') return run
            if (run.syncState !== 'pending') return yield* invalid()
            const branch = `folio/task/${value.taskId}`
            const source = yield* checkout({ taskId: value.taskId, branch })
            if (
              (yield* git(source.path, ['rev-parse', 'HEAD'])).trim() !== value.expectedHead ||
              !(yield* isRegisteredGitCommit(branch, value.expectedHead, source.base)) ||
              (yield* sql`SELECT p.id FROM git_change_preparations p LEFT JOIN git_change_applications a ON a.id=p.id
                WHERE p.task_id=${value.taskId} AND (a.id IS NULL OR a.state<>'applied') LIMIT 1`).length ||
              (yield* git(source.path, [
                '--no-optional-locks',
                'diff',
                '--no-ext-diff',
                '--no-textconv',
                '--no-renames',
                '--name-only',
                '-z',
                value.expectedHead,
                '--',
                'wiki'
              ])) ||
              (yield* git(source.path, ['ls-files', '--others', '--exclude-standard', '-z', '--', 'wiki']))
            )
              return yield* invalid()
            const changed = yield* sql`UPDATE runs SET sync_state='not-required'
              WHERE id=${value.runId} AND task_id=${value.taskId} AND state='succeeded' AND sync_state='pending'
                AND baseline_commit=${value.expectedHead} RETURNING id`
            run = (yield* store.runs(value.taskId)).find((candidate) => candidate.id === value.runId)
            if (!run || (!changed.length && run.syncState !== 'not-required')) return yield* invalid()
            return run
          },
          Effect.provide(dependencies),
          Effect.mapError(storage),
          lock.withLock
        )

        /** Applies already-prepared intent under the same gate used by capture/save and worktree creation. */
        const apply = (id: string) => lock.withLock(applyLocked(id))

        /** Recovery requires existing application intent; it cannot create a new index plan. */
        const recover = Effect.fn('GitChangeApplications.recover')(function* (id: string) {
          if (!(yield* find(id))) return yield* invalid()
          return yield* apply(id)
        }, Effect.mapError(storage))
        const pending = sql`SELECT a.id, a.branch, p.commit_oid AS "commit", a.state FROM git_change_applications a
        JOIN git_change_preparations p ON p.id=a.id WHERE a.state='applying' ORDER BY a.id`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(GitChangeApplication))),
          Effect.mapError(storage)
        )
        return GitChangeApplications.of({ save, saveRunWiki, confirmRunWikiUnchanged, apply, recover, pending })
      }).pipe(Effect.mapError(storage))
    ).pipe(Layer.provide(VaultGitWriteLock.layer(directory)))
  }
}
