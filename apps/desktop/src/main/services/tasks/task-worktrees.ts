import { Context, Effect, FileSystem, Layer, Schema } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { HarnessStoreError, TaskConfiguration, type TaskRecord } from '../../../shared/harness'
import { HarnessStore } from '../harness/harness-store'
import { makeVaultGit } from '../git/vault-git'
import { isRegisteredGitCommit } from '../git/git-change-applications'
import { VaultGitWriteLock } from '../git/vault-git-write-lock'

const TaskId = Schema.NonEmptyString.check(Schema.makeFilter((id) => /^[a-zA-Z0-9_-]{1,128}$/.test(id)))
const Commit = Schema.String.check(Schema.makeFilter((value) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)))
const Draft = Schema.Struct({ id: TaskId, goal: Schema.NonEmptyString, configuration: TaskConfiguration })
export type TaskDraft = typeof Draft.Type
export interface TaskCheckout {
  readonly path: string
  readonly branch: string
  readonly baselineCommit: string
}
const invalid = () => new HarnessStoreError({ reason: 'invalid-state', message: 'Task worktree or registered main baseline requires attention.' })
const storage = (cause: unknown) =>
  cause instanceof HarnessStoreError ? cause : new HarnessStoreError({ reason: 'storage', message: 'Could not manage the Task worktree.' })

/**
 * Owns worktree creation and release checkpoints. It never resets, force-checks-out or commits user files.
 * A failed Git/DB boundary remains retryable and is verified against the real checkout before advancing.
 */
export class TaskWorktrees extends Context.Service<
  TaskWorktrees,
  {
    readonly create: (input: TaskDraft) => Effect.Effect<TaskCheckout, HarnessStoreError>
    readonly reserve: (input: TaskDraft) => Effect.Effect<void, HarnessStoreError>
    readonly ensure: (taskId: string, claim?: { id: string; owner: string }) => Effect.Effect<TaskCheckout, HarnessStoreError>
    readonly complete: (taskId: string) => Effect.Effect<TaskRecord, HarnessStoreError>
    /** Reopens a released manual Task from the current registered main without rewriting history. */
    readonly reopen: (taskId: string) => Effect.Effect<TaskCheckout, HarnessStoreError>
  }
>()('folio/services/TaskWorktrees') {
  static layer(directory: string) {
    return Layer.effect(
      TaskWorktrees,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const sql = yield* SqlClient.SqlClient
        const store = yield* HarnessStore
        const git = yield* makeVaultGit
        const root = yield* fs.realPath(directory)
        const main = join(root, 'workspace')
        const parent = join(root, 'worktrees')
        const lock = yield* VaultGitWriteLock

        /** Verifies a persisted Task's exact path, repository and branch; never repairs mismatched content by overwriting it. */
        const ensureLocked = Effect.fn('TaskWorktrees.ensureLocked')(
          function* (taskId: string, checkpoint?: { readonly taskHead: string; readonly mainHead: string }, claim?: { id: string; owner: string }) {
            yield* Schema.decodeUnknownEffect(TaskId)(taskId)
            let task = yield* store.task(taskId)
            const path = join(parent, taskId)
            const branch = `folio/task/${taskId}`
            if (task.state !== 'active' || task.worktree !== path || task.branch !== branch) return yield* invalid()
            const active = yield* sql`SELECT id FROM runs WHERE task_id=${taskId} AND state IN ('preparing', 'running')
              AND NOT (id IS ${claim?.id ?? null} AND owner IS ${claim?.owner ?? null} AND state='preparing' AND baseline_commit IS NULL)`
            if (active.length) return yield* new HarnessStoreError({ reason: 'task-busy', message: 'Task has an active Run.' })
            const saving = yield* sql`SELECT a.id FROM git_change_applications a JOIN git_change_preparations p ON p.id=a.id
          WHERE p.task_id=${taskId} AND a.state='applying'`
            if (saving.length) return yield* invalid()
            if (
              (yield* sql`SELECT pending.id FROM git_sync_operations pending WHERE pending.task_id=${taskId} AND pending.state NOT IN ('aligned', 'aborted')
              AND (pending.state<>'superseded' OR NOT EXISTS (
                SELECT 1 FROM git_sync_operations replacement WHERE replacement.supersedes_id=pending.id))`).length
            )
              return yield* invalid()
            yield* fs.makeDirectory(parent, { recursive: true })
            if ((yield* fs.realPath(parent)) !== parent) return yield* invalid()
            const marker = yield* fs
              .readFileString(join(main, '.git', 'folio-workspace.json'))
              .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ version: Schema.Literal(1), initialCommit: Commit })))))
            if ((yield* git(main, ['rev-parse', '--show-toplevel'])).trim() !== main || (yield* git(main, ['branch', '--show-current'])).trim() !== 'main') return yield* invalid()
            if (task.worktreeState === 'pending') {
              const base = (yield* git(main, ['rev-parse', 'refs/heads/main'])).trim()
              if (!(yield* isRegisteredGitCommit('main', base, marker.initialCommit).pipe(Effect.provideService(SqlClient.SqlClient, sql)))) return yield* invalid()
              yield* sql`UPDATE tasks SET worktree_state='creating', worktree_base=${base} WHERE id=${taskId} AND worktree_state='pending'`
              task = yield* store.task(taskId)
            }
            const base = yield* Schema.decodeUnknownEffect(Commit)(task.worktreeBase).pipe(Effect.mapError(invalid))
            if (!(yield* fs.exists(path))) {
              if (task.worktreeState !== 'creating') return yield* invalid()
              const ref = `refs/heads/${branch}`
              const existing = (yield* git(main, ['for-each-ref', '--format=%(refname)', ref])).trim()
              if (existing) {
                if (existing !== ref || (yield* git(main, ['rev-parse', ref])).trim() !== base) return yield* invalid()
                yield* git(main, ['worktree', 'add', path, branch])
              } else yield* git(main, ['worktree', 'add', '-b', branch, path, base])
            }
            const info = yield* Effect.tryPromise(() => lstat(join(path, '.git')))
            if (!info.isFile() || info.isSymbolicLink() || (yield* fs.realPath(path)) !== path) return yield* invalid()
            const common = (yield* git(path, ['rev-parse', '--git-common-dir'])).trim()
            if (
              (yield* fs.realPath(resolve(path, common))) !== join(main, '.git') ||
              (yield* git(path, ['rev-parse', '--show-toplevel'])).trim() !== path ||
              (yield* git(path, ['branch', '--show-current'])).trim() !== branch
            )
              return yield* invalid()
            if (task.worktreeState === 'creating') {
              if ((yield* git(path, ['rev-parse', 'HEAD'])).trim() !== base || (yield* git(path, ['status', '--porcelain', '--untracked-files=all'])).trim() !== '')
                return yield* invalid()
              // Git does not reproduce empty directories; create required inputs without touching their files.
              yield* fs.makeDirectory(join(path, 'wiki'), { recursive: true })
              yield* fs.makeDirectory(join(path, 'raws'), { recursive: true })
              const changed = yield* sql`UPDATE tasks SET worktree_state='ready' WHERE id=${taskId}
            AND worktree_state='creating' AND worktree_base=${base} RETURNING id`
              if (!changed.length && (yield* store.task(taskId)).worktreeState !== 'ready') return yield* invalid()
            }
            const synchronized = checkpoint
              ? []
              : yield* sql<{ alignedHead: string; publishedHead: string }>`SELECT
              aligned_head AS alignedHead, published_head AS publishedHead FROM git_sync_operations
              WHERE task_id=${taskId} AND state='aligned' ORDER BY sequence DESC LIMIT 1`
            const expectedTaskHead = checkpoint?.taskHead ?? synchronized[0]?.alignedHead ?? base
            const expectedMainHead = checkpoint?.mainHead ?? synchronized[0]?.publishedHead ?? base
            // Execution may only reuse a checkout at its last completed two-sided checkpoint.
            // A newer main or Task commit must pass through TaskGitSynchronization first; ensure
            // never updates or overwrites either checkout on the caller's behalf.
            if ((yield* git(path, ['rev-parse', 'HEAD'])).trim() !== expectedTaskHead || (yield* git(main, ['rev-parse', 'refs/heads/main'])).trim() !== expectedMainHead)
              return yield* invalid()
            return { path, branch, baselineCommit: base }
          },
          Effect.mapError(storage)
        )

        /** Releases only a fully settled checkout; a crash leaves a durable retryable state. */
        const completeLocked = Effect.fn('TaskWorktrees.completeLocked')(function* (taskId: string) {
          yield* Schema.decodeUnknownEffect(TaskId)(taskId)
          let task = yield* store.task(taskId)
          const path = join(parent, taskId)
          const branch = `folio/task/${taskId}`
          if (task.worktree !== path || task.branch !== branch) return yield* invalid()
          const registered = Effect.fn('TaskWorktrees.registeredForRelease')(function* () {
            return (yield* git(main, ['worktree', 'list', '--porcelain'])).split('\n').some((line) => line === `worktree ${path}`)
          })
          // A Task cancelled before its first dispatch has no checkout or baseline to release.
          if (task.worktreeBase === null && (task.worktreeState === 'pending' || task.worktreeState === 'released')) {
            if ((yield* fs.exists(path)) || (yield* registered())) return yield* invalid()
            if ((yield* sql`SELECT id FROM runs WHERE task_id=${taskId} AND ended_at IS NULL`).length) return yield* invalid()
            yield* sql`UPDATE tasks SET state='completed', worktree_state='released' WHERE id=${taskId}`
            return yield* store.task(taskId)
          }
          const base = yield* Schema.decodeUnknownEffect(Commit)(task.worktreeBase).pipe(Effect.mapError(invalid))
          const synchronized = yield* sql<{ alignedHead: string }>`SELECT aligned_head AS alignedHead FROM git_sync_operations
            WHERE task_id=${taskId} AND state='aligned' ORDER BY sequence DESC LIMIT 1`
          const expectedHead = synchronized[0]?.alignedHead ?? base
          if (task.state === 'completed' && task.worktreeState === 'released') {
            if (
              (yield* fs.exists(path)) ||
              (yield* registered()) ||
              (yield* git(main, ['for-each-ref', '--format=%(objectname)', `refs/heads/${branch}`])).trim() !== expectedHead
            )
              return yield* invalid()
            return task
          }
          if (task.state === 'active' && task.worktreeState === 'ready') {
            yield* ensureLocked(taskId)
            if (
              (yield* sql`SELECT id FROM runs WHERE task_id=${taskId} AND state='succeeded'
                AND sync_state NOT IN ('completed', 'not-required')`).length ||
              (yield* git(path, ['status', '--porcelain', '--untracked-files=all'])).trim() ||
              (yield* git(path, ['rev-parse', 'HEAD^{tree}'])).trim() !== (yield* git(main, ['rev-parse', 'HEAD^{tree}'])).trim()
            )
              return yield* invalid()
            // The SQL predicate closes the cross-process gap after the preflight: either an
            // active Run reserves first and this update loses, or completion wins and later
            // Run admission observes the non-active Task.
            const changed = yield* sql`UPDATE tasks SET state='completed', worktree_state='releasing'
              WHERE id=${taskId} AND state='active' AND worktree_state='ready'
              AND NOT EXISTS (SELECT 1 FROM runs WHERE task_id=${taskId} AND state IN ('preparing', 'running'))
              AND NOT EXISTS (SELECT 1 FROM runs WHERE task_id=${taskId} AND state='succeeded'
                AND sync_state NOT IN ('completed', 'not-required')) RETURNING id`
            if (!changed.length) return yield* invalid()
            task = yield* store.task(taskId)
          }
          if (task.state !== 'completed' || task.worktreeState !== 'releasing') return yield* invalid()
          if (yield* fs.exists(path)) {
            if (!(yield* fs.exists(join(path, '.git')))) return yield* invalid()
            const info = yield* Effect.tryPromise(() => lstat(join(path, '.git')))
            if (
              !info.isFile() ||
              info.isSymbolicLink() ||
              (yield* fs.realPath(path)) !== path ||
              (yield* fs.realPath(resolve(path, (yield* git(path, ['rev-parse', '--git-common-dir'])).trim()))) !== join(main, '.git') ||
              (yield* git(path, ['rev-parse', '--show-toplevel'])).trim() !== path ||
              (yield* git(path, ['symbolic-ref', 'HEAD'])).trim() !== `refs/heads/${branch}` ||
              (yield* git(path, ['rev-parse', 'HEAD'])).trim() !== expectedHead ||
              (yield* git(path, ['status', '--porcelain', '--untracked-files=all'])).trim()
            )
              return yield* invalid()
            yield* git(main, ['worktree', 'remove', path])
          } else if (yield* registered()) return yield* invalid()
          // A lost SQLite receipt must not turn a deleted or moved Task branch into a
          // successful release: the branch is the durable history retained after checkout removal.
          if ((yield* git(main, ['for-each-ref', '--format=%(objectname)', `refs/heads/${branch}`])).trim() !== expectedHead) return yield* invalid()
          const released = yield* sql`UPDATE tasks SET worktree_state='released'
            WHERE id=${taskId} AND state='completed' AND worktree_state='releasing' RETURNING id`
          if (!released.length && (yield* store.task(taskId)).worktreeState !== 'released') return yield* invalid()
          return yield* store.task(taskId)
        }, Effect.mapError(storage))

        /**
         * Rebuilds a released checkout at the current main tree while retaining the old Task
         * branch head under a protected ref. The branch move is compare-and-swap based; if the
         * following SQLite transition fails, the protected reopen ref makes the same request
         * safely retryable without deleting or resetting any checkout.
         */
        const reopenLocked = Effect.fn('TaskWorktrees.reopenLocked')(function* (taskId: string) {
          yield* Schema.decodeUnknownEffect(TaskId)(taskId)
          const task = yield* store.task(taskId)
          const path = join(parent, taskId)
          const branch = `folio/task/${taskId}`
          if (task.state !== 'completed' || task.worktreeState !== 'released' || task.worktree !== path || task.branch !== branch)
            return yield* invalid()
          if (yield* fs.exists(path)) return yield* invalid()
          const registered = (yield* git(main, ['worktree', 'list', '--porcelain'])).split('\n').some((line) => line === `worktree ${path}`)
          if (registered) return yield* invalid()
          if (task.worktreeBase === null) {
            yield* sql`UPDATE tasks SET state='active', worktree_state='pending' WHERE id=${taskId} AND state='completed'`
            return yield* ensureLocked(taskId)
          }
          if (
            (yield* fs.realPath(main)) !== main ||
            (yield* fs.realPath(join(main, '.git'))) !== join(main, '.git') ||
            (yield* git(main, ['rev-parse', '--show-toplevel'])).trim() !== main ||
            (yield* git(main, ['branch', '--show-current'])).trim() !== 'main' ||
            (yield* git(main, ['status', '--porcelain', '--untracked-files=all'])).trim()
          )
            return yield* invalid()
          const marker = yield* fs
            .readFileString(join(main, '.git', 'folio-workspace.json'))
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ version: Schema.Literal(1), initialCommit: Commit })))))
          const mainHead = (yield* git(main, ['rev-parse', 'refs/heads/main'])).trim()
          if (!(yield* isRegisteredGitCommit('main', mainHead, marker.initialCommit).pipe(Effect.provideService(SqlClient.SqlClient, sql)))) return yield* invalid()
          const branchRef = `refs/heads/${branch}`
          const branchValue = (yield* git(main, ['for-each-ref', '--format=%(objectname)', branchRef])).trim()
          if (!branchValue) return yield* invalid()
          const expectedTaskHead = (yield* sql<{ alignedHead: string }>`SELECT aligned_head AS alignedHead FROM git_sync_operations
            WHERE task_id=${taskId} AND state='aligned' ORDER BY sequence DESC LIMIT 1`)[0]?.alignedHead ?? task.worktreeBase
          if (!expectedTaskHead) return yield* invalid()

          // A previous attempt may have moved the branch before its SQL receipt was written.
          // Its generation-specific protected ref is both the recovery marker and history pin.
          const reopenRef = `refs/folio/task/${taskId}/reopen/${mainHead}`
          const recordedOld = (yield* git(main, ['for-each-ref', '--format=%(objectname)', reopenRef])).trim()
          if (recordedOld && recordedOld !== expectedTaskHead) return yield* invalid()
          if (branchValue !== mainHead) {
            if (branchValue !== expectedTaskHead) return yield* invalid()
            if (!recordedOld) {
              yield* git(main, ['update-ref', '--no-deref', reopenRef, branchValue, '0'.repeat(branchValue.length)])
            }
            yield* git(main, ['update-ref', '--no-deref', branchRef, mainHead, branchValue])
          } else if (!recordedOld) {
            // No branch move is needed when the released Task already ended at current main;
            // still pin that head so a later receipt retry has an explicit identity marker.
            yield* git(main, ['update-ref', '--no-deref', reopenRef, branchValue, '0'.repeat(branchValue.length)])
          }
          const changed = yield* sql`UPDATE tasks SET state='active', worktree_state='creating', worktree_base=${mainHead}
            WHERE id=${taskId} AND state='completed' AND worktree_state='released' RETURNING id`
          if (!changed.length) {
            const current = yield* store.task(taskId)
            if (current.state !== 'active' || current.worktreeState !== 'creating' || current.worktreeBase !== mainHead) return yield* invalid()
          }
          // Reopen establishes a new two-sided checkpoint at current main. The historical
          // aligned operation remains immutable, so the explicit checkpoint prevents ensure
          // from validating the newly-created checkout against that stale receipt.
          return yield* ensureLocked(taskId, { taskHead: mainHead, mainHead })
        }, Effect.mapError(storage))

        const ensure = (taskId: string, claim?: { id: string; owner: string }) => lock.withLock(ensureLocked(taskId, undefined, claim))
        const complete = (taskId: string) => lock.withLock(completeLocked(taskId))
        const reopen = (taskId: string) => lock.withLock(reopenLocked(taskId))

        /** Persists Task identity before touching Git so failed creation can be retried by the same ID. */
        const reserve = Effect.fn('TaskWorktrees.reserve')(function* (input: TaskDraft) {
          const value = yield* Schema.decodeUnknownEffect(Draft)(input)
          yield* store.createTask({ ...value, branch: `folio/task/${value.id}`, worktree: join(parent, value.id) })
        }, Effect.mapError(storage))
        const create = (input: TaskDraft) => reserve(input).pipe(Effect.andThen(ensure(input.id)))
        return TaskWorktrees.of({ create, reserve, ensure, complete, reopen })
      }).pipe(Effect.mapError(storage))
    ).pipe(Layer.provide(VaultGitWriteLock.layer(directory)))
  }
}
