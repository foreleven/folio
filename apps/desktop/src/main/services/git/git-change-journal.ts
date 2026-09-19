import { Context, DateTime, Effect, FileSystem, Layer, Schema } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { join, resolve } from 'node:path'
import { GitChangeIntent, GitChangePreparation, GitObjectId, GitSelectedPath } from '../../../shared/git-change'
import { HarnessStoreError } from '../../../shared/harness'
import { HarnessStore } from '../harness/harness-store'
import { makeVaultGit } from './vault-git'
import { gitCommitData, gitCommitHash } from './git-commit-object'

const Row = Schema.Struct({
  ...GitChangePreparation.fields,
  runIds: Schema.fromJsonString(GitChangeIntent.fields.runIds),
  paths: Schema.fromJsonString(Schema.NonEmptyArray(GitSelectedPath)),
  data: Schema.String
})
type Row = typeof Row.Type
const invalid = () => new HarnessStoreError({ reason: 'invalid-state', message: 'Saved Git change requires inspection before continuing.' })
const storage = (error: unknown) =>
  error instanceof HarnessStoreError
    ? error
    : new HarnessStoreError({
        reason: 'storage',
        message: 'Could not prepare the Git change. Its recorded intent has been retained.'
      })

/** Deterministic raw commit bytes: retries use the journal's clock and never reread working files. */
function commitData(value: GitChangeIntent, createdAt: number): string {
  return gitCommitData({
    tree: value.tree,
    parent: value.parent,
    createdAt,
    message:
      `Save ${value.kind} changes\n\nFolio-Change-Id: ${value.id}\nFolio-Change-Kind: ${value.kind}\n` +
      (value.taskId === null ? '' : `Folio-Task-Id: ${value.taskId}\n`) +
      value.runIds.map((runId) => `Folio-Run-Id: ${runId}\n`).join('')
  })
}

/** Stable intent equality excludes the generated timestamp and preparation state. */
function matches(row: Row, value: GitChangeIntent): boolean {
  return (
    row.id === value.id &&
    row.taskId === value.taskId &&
    JSON.stringify(row.runIds) === JSON.stringify(value.runIds) &&
    row.kind === value.kind &&
    row.parent === value.parent &&
    row.tree === value.tree &&
    JSON.stringify(row.paths) === JSON.stringify(value.paths)
  )
}

/**
 * Journals frozen commits and protects them from Git GC. It does not apply a commit, touch a
 * checkout/index, declare a baseline registered, or prove native writers stopped. The save
 * coordinator must own that boundary before capturing a tree and applying the retained commit.
 */
export class GitChangeJournal extends Context.Service<
  GitChangeJournal,
  {
    readonly prepare: (input: GitChangeIntent) => Effect.Effect<GitChangePreparation, HarnessStoreError>
    readonly recover: (id: string) => Effect.Effect<GitChangePreparation, HarnessStoreError>
    readonly get: (id: string) => Effect.Effect<GitChangePreparation, HarnessStoreError>
    readonly pending: Effect.Effect<readonly GitChangePreparation[], HarnessStoreError>
  }
>()('folio/services/GitChangeJournal') {
  static layer(directory: string) {
    return Layer.effect(
      GitChangeJournal,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const sql = yield* SqlClient.SqlClient
        const store = yield* HarnessStore
        const git = yield* makeVaultGit
        const root = yield* fs.realPath(directory)
        const main = join(root, 'workspace')

        /** Reads intent without changing Git; absence remains distinct from a damaged record. */
        const find = Effect.fn('GitChangeJournal.find')(function* (id: string) {
          yield* Schema.decodeUnknownEffect(GitChangeIntent.fields.id)(id)
          const rows = yield* sql`SELECT p.id, p.task_id AS taskId, p.kind, p.branch, p.parent, p.tree, p.paths,
          (SELECT json_group_array(run_id) FROM (SELECT run_id FROM git_change_preparation_runs
            WHERE preparation_id=p.id ORDER BY run_id)) AS runIds,
          commit_oid AS "commit", commit_data AS data, created_at AS createdAt, state
          FROM git_change_preparations p WHERE p.id=${id}`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Row))))
          return rows[0]
        })

        /** Checks the Vault repository and object format before reading or writing retained objects. */
        const repository = Effect.fn('GitChangeJournal.repository')(function* () {
          if (
            (yield* fs.realPath(main)) !== main ||
            (yield* fs.realPath(join(main, '.git'))) !== join(main, '.git') ||
            (yield* git(main, ['rev-parse', '--show-toplevel'])).trim() !== main
          )
            return yield* invalid()
          const marker = yield* fs
            .readFileString(join(main, '.git', 'folio-workspace.json'))
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ version: Schema.Literal(1), initialCommit: GitObjectId })))))
          if ((yield* git(main, ['cat-file', '-t', marker.initialCommit])).trim() !== 'commit') return yield* invalid()
          return yield* Schema.decodeUnknownEffect(Schema.Literals(['sha1', 'sha256']))((yield* git(main, ['rev-parse', '--show-object-format'])).trim())
        })

        /** Ensures the frozen tree changes only selected paths, with Agent raws/wiki kept separate. */
        const validateTree = Effect.fn('GitChangeJournal.validateTree')(function* (value: GitChangeIntent) {
          if ((yield* git(main, ['cat-file', '-t', value.parent])).trim() !== 'commit' || (yield* git(main, ['cat-file', '-t', value.tree])).trim() !== 'tree')
            return yield* invalid()
          const changed = (yield* git(main, ['diff-tree', '--no-renames', '--no-commit-id', '--name-only', '-r', '-z', value.parent, value.tree])).split('\0').filter(Boolean)
          if (!changed.length || changed.some((path) => !value.paths.includes(path)) || (value.kind !== 'user' && value.paths.some((path) => !path.startsWith(`${value.kind}/`))))
            return yield* invalid()
        })

        /** Allocates one immutable intent before any commit-object or retention-ref write. */
        const reserve = Effect.fn('GitChangeJournal.reserve')(function* (value: GitChangeIntent) {
          const previous = yield* find(value.id)
          if (previous) {
            if (!matches(previous, value)) return yield* invalid()
            return previous
          }
          const format = yield* repository()
          let path = main
          let branch = 'main'
          if (value.taskId !== null) {
            const task = yield* store.task(value.taskId)
            path = join(root, 'worktrees', value.taskId)
            branch = `folio/task/${value.taskId}`
            if (task.state !== 'active' || task.worktreeState !== 'ready' || task.worktree !== path || task.branch !== branch) return yield* invalid()
            if ((yield* store.runs(value.taskId)).some((run) => run.state === 'preparing' || run.state === 'running')) return yield* invalid()
          }
          if (value.kind === 'user' ? value.runIds.length !== 0 : value.taskId === null || value.runIds.length === 0) return yield* invalid()
          if (value.runIds.length !== 0) {
            const runs = yield* store.runs(value.taskId!)
            if (
              value.runIds.some((runId) =>
                !runs.some(
                  (run) =>
                    run.id === runId &&
                    run.state === 'succeeded' &&
                    (value.kind !== 'wiki' || run.syncState === 'pending' || run.syncState === 'failed')
                )
              )
            )
              return yield* invalid()
          }
          if (
            (yield* fs.realPath(path)) !== path ||
            (yield* git(path, ['rev-parse', '--show-toplevel'])).trim() !== path ||
            (yield* fs.realPath(resolve(path, (yield* git(path, ['rev-parse', '--git-common-dir'])).trim()))) !== join(main, '.git') ||
            (yield* git(path, ['branch', '--show-current'])).trim() !== branch ||
            (yield* git(path, ['rev-parse', 'HEAD'])).trim() !== value.parent
          )
            return yield* invalid()
          yield* validateTree(value)
          const createdAt = DateTime.toEpochMillis(yield* DateTime.now)
          const data = commitData(value, createdAt)
          const commit = gitCommitHash(data, format)
          // INSERT conflict is an exact-id retry only, never an overwrite of a different tree.
          yield* sql.withTransaction(Effect.gen(function* () {
            const concurrent = yield* find(value.id)
            if (concurrent) {
              if (!matches(concurrent, value)) return yield* invalid()
              return
            }
            yield* sql`INSERT INTO git_change_preparations
            (id, task_id, kind, branch, parent, tree, paths, commit_oid, commit_data, created_at, state)
            VALUES (${value.id}, ${value.taskId}, ${value.kind}, ${branch}, ${value.parent}, ${value.tree},
              ${JSON.stringify(value.paths)}, ${commit}, ${data}, ${createdAt}, 'preparing')`
            for (const runId of value.runIds) {
              yield* sql`INSERT INTO git_change_preparation_runs (preparation_id, task_id, kind, run_id)
                VALUES (${value.id}, ${value.taskId}, ${value.kind}, ${runId})`
            }
          }))
          const recorded = yield* find(value.id)
          if (!recorded || !matches(recorded, value)) return yield* invalid()
          return recorded
        })

        /**
         * Recreates only deterministic commit bytes, then CAS-creates a protected ref. A missing
         * source tree or mismatched existing ref requires inspection, never a fresh filesystem snapshot.
         */
        const retain = Effect.fn('GitChangeJournal.retain')(function* (row: Row) {
          const format = yield* repository()
          if (
            row.data !== commitData(row, row.createdAt) ||
            row.commit !== gitCommitHash(row.data, format) ||
            row.branch !== (row.taskId === null ? 'main' : `folio/task/${row.taskId}`)
          )
            return yield* invalid()
          yield* validateTree(row)
          if (
            (yield* git(main, ['hash-object', '-t', 'commit', '-w', '--stdin'], { input: row.data })).trim() !== row.commit ||
            (yield* git(main, ['cat-file', 'commit', row.commit])) !== row.data
          )
            return yield* invalid()
          const ref = `refs/folio/changes/${row.id}`
          const expected = `${ref} ${row.commit}`
          const readRef = () => git(main, ['for-each-ref', '--format=%(refname) %(objectname) %(symref)', ref]).pipe(Effect.map((value) => value.trim()))
          const before = yield* readRef()
          if (before && before !== expected) return yield* invalid()
          if (!before) {
            // A competing exact recovery may win CAS. Verify its result; never force an existing ref.
            yield* git(main, ['update-ref', '--no-deref', ref, row.commit, '0'.repeat(row.commit.length)]).pipe(
              Effect.catch((error) => readRef().pipe(Effect.flatMap((current) => (current === expected ? Effect.void : Effect.fail(error)))))
            )
          }
          if ((yield* readRef()) !== expected) return yield* invalid()
          yield* sql`UPDATE git_change_preparations SET state='prepared' WHERE id=${row.id} AND commit_oid=${row.commit}`
          const current = yield* find(row.id)
          if (!current || current.state !== 'prepared') return yield* invalid()
          const { data: _, ...result } = current
          return result
        })

        /** Resumes a saved Git/SQLite boundary even if checkout files or HEAD have since changed. */
        const recover = Effect.fn('GitChangeJournal.recover')(function* (id: string) {
          const row = yield* find(id)
          if (!row) return yield* new HarnessStoreError({ reason: 'not-found', message: 'Saved Git change was not found.' })
          return yield* retain(row)
        }, Effect.mapError(storage))

        /** Normalizes set order so retrying the same file selection preserves its original intent. */
        const prepare = Effect.fn('GitChangeJournal.prepare')(function* (input: GitChangeIntent) {
          const decoded = yield* Schema.decodeUnknownEffect(GitChangeIntent)(input, { onExcessProperty: 'error' })
          const value = yield* Schema.decodeUnknownEffect(GitChangeIntent)({
            ...decoded,
            runIds: [...new Set(decoded.runIds)].sort(),
            paths: [...new Set(decoded.paths)].sort()
          })
          return yield* retain(yield* reserve(value))
        }, Effect.mapError(storage))

        /** Returns journal state only; a prepared row alone is not evidence that Git still retains it. */
        const get = Effect.fn('GitChangeJournal.get')(function* (id: string) {
          const row = yield* find(id)
          if (!row) return yield* new HarnessStoreError({ reason: 'not-found', message: 'Saved Git change was not found.' })
          const { data: _, ...result } = row
          return result
        }, Effect.mapError(storage))
        // Recovery discovers unfinished identities after a restart even if the caller lost its reply.
        const pending = sql`SELECT p.id, p.task_id AS taskId, p.kind, p.branch, p.parent, p.tree, p.paths,
        (SELECT json_group_array(run_id) FROM (SELECT run_id FROM git_change_preparation_runs
          WHERE preparation_id=p.id ORDER BY run_id)) AS runIds,
        commit_oid AS "commit", commit_data AS data, created_at AS createdAt, state
        FROM git_change_preparations p WHERE state='preparing' ORDER BY created_at, id`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Row))),
          Effect.map((rows) => rows.map(({ data: _, ...row }) => row)),
          Effect.mapError(storage)
        )
        return GitChangeJournal.of({ prepare, recover, get, pending })
      }).pipe(Effect.mapError(storage))
    )
  }
}
