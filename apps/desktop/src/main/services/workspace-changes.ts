import { Context, Effect, FileSystem, Layer, Schema } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { ChildProcessSpawner } from 'effect/unstable/process'
import { lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { GitObjectId, GitSelectedPath, PendingWorkspaceSave, WorkspaceChangesView, WorkspaceDiffInput, WorkspaceFileDiff } from '../../shared/git-change'
import { HarnessStoreError } from '../../shared/harness'
import { isRegisteredGitCommit } from './git-change-applications'
import { GitChangeJournal } from './git-change-journal'
import { HarnessStore } from './harness-store'
import { snapshotGitChange } from './git-change-snapshot'
import { makeVaultGit } from './vault-git'

const invalid = () => new HarnessStoreError({ reason: 'invalid-state', message: 'Workspace changed. Refresh before reviewing its files.' })
const storage = (cause: unknown) => (cause instanceof HarnessStoreError ? cause : new HarnessStoreError({ reason: 'storage', message: 'Could not read workspace changes.' }))
const missing = Schema.is(Schema.Struct({ code: Schema.Literal('ENOENT') }))
const previewLimit = 128 * 1024

/** Lists main or Task-wiki changes and retained save intent. Queries never apply, register or retry a save. */
export class WorkspaceChanges extends Context.Service<
  WorkspaceChanges,
  {
    readonly inspect: Effect.Effect<WorkspaceChangesView, HarnessStoreError>
    readonly diff: (input: WorkspaceDiffInput) => Effect.Effect<WorkspaceFileDiff, HarnessStoreError>
    readonly inspectTaskWiki: (taskId: string) => Effect.Effect<WorkspaceChangesView, HarnessStoreError>
    readonly diffTaskWiki: (taskId: string, input: WorkspaceDiffInput) => Effect.Effect<WorkspaceFileDiff, HarnessStoreError>
  }
>()('folio/services/WorkspaceChanges') {
  static layer(directory: string) {
    return Layer.effect(
      WorkspaceChanges,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const sql = yield* SqlClient.SqlClient
        const journal = yield* GitChangeJournal
        const store = yield* HarnessStore
        const dependencies = yield* Effect.context<FileSystem.FileSystem | SqlClient.SqlClient | ChildProcessSpawner.ChildProcessSpawner>()
        const git = yield* makeVaultGit
        const root = yield* fs.realPath(directory)
        const main = join(root, 'workspace')

        /** Resolves only a Vault-owned main checkout or the exact persisted Task worktree. */
        const baseline = Effect.fn('WorkspaceChanges.baseline')(function* (taskId: string | null) {
          if (
            (yield* fs.realPath(main)) !== main ||
            (yield* fs.realPath(join(main, '.git'))) !== join(main, '.git') ||
            (yield* git(main, ['rev-parse', '--show-toplevel'])).trim() !== main ||
            (yield* git(main, ['symbolic-ref', 'HEAD'])).trim() !== 'refs/heads/main'
          )
            return yield* invalid()
          const marker = yield* fs
            .readFileString(join(main, '.git/folio-workspace.json'))
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ version: Schema.Literal(1), initialCommit: GitObjectId })))))
          let path = main
          let branch = 'main'
          let registeredBase = marker.initialCommit
          if (taskId !== null) {
            const task = yield* store.task(taskId)
            path = join(root, 'worktrees', taskId)
            branch = `folio/task/${taskId}`
            const info = yield* Effect.tryPromise(() => lstat(join(path, '.git')))
            if (
              task.state !== 'active' ||
              task.worktreeState !== 'ready' ||
              task.worktree !== path ||
              task.branch !== branch ||
              !task.worktreeBase ||
              !info.isFile() ||
              info.isSymbolicLink() ||
              (yield* fs.realPath(path)) !== path ||
              (yield* fs.realPath(resolve(path, (yield* git(path, ['rev-parse', '--git-common-dir'])).trim()))) !== join(main, '.git')
            )
              return yield* invalid()
            registeredBase = task.worktreeBase
          }
          if ((yield* git(path, ['rev-parse', '--show-toplevel'])).trim() !== path || (yield* git(path, ['symbolic-ref', 'HEAD'])).trim() !== `refs/heads/${branch}`)
            return yield* invalid()
          const head = yield* Schema.decodeUnknownEffect(GitObjectId)((yield* git(path, ['rev-parse', 'HEAD'])).trim())
          return { taskId, path, branch, head, registered: yield* isRegisteredGitCommit(branch, head, registeredBase) }
        })

        /** Checks every ancestor without following symlinks; a missing leaf remains a selectable deletion. */
        const fileInfo = Effect.fn('WorkspaceChanges.fileInfo')(function* (rootPath: string, selectedPath: string, wikiOnly: boolean) {
          if (!Schema.is(GitSelectedPath)(selectedPath) || (wikiOnly && !selectedPath.startsWith('wiki/'))) return { selectable: false, size: 0 }
          const parts = selectedPath.split('/')
          let size = 0
          for (let index = 0; index < parts.length; index++) {
            const info = yield* Effect.tryPromise(() =>
              lstat(join(rootPath, ...parts.slice(0, index + 1))).catch((error) => {
                if (missing(error)) return null
                throw error
              })
            )
            if (info && (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory()))) return { selectable: false, size: 0 }
            if (index === parts.length - 1) size = info?.size ?? 0
          }
          return { selectable: true, size }
        })

        const inspectTarget = Effect.fn('WorkspaceChanges.inspectTarget')(
          function* (taskId: string | null) {
            const base = yield* baseline(taskId)
            const pathspec = taskId === null ? [] : ['--', 'wiki']
            // Comparing HEAD to disk excludes staged-only edits already undone in the working file.
            const output = (yield* git(base.path, ['--no-optional-locks', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', base.head, ...pathspec]))
              .split('\0')
              .filter(Boolean)
            const paths = new Map<string, 'added' | 'modified' | 'deleted'>()
            if (output.length % 2 !== 0) return yield* invalid()
            for (let i = 0; i < output.length; i += 2) paths.set(output[i + 1]!, output[i] === 'A' ? 'added' : output[i] === 'D' ? 'deleted' : 'modified')
            for (const path of (yield* git(base.path, ['ls-files', '--others', '--exclude-standard', '-z', ...pathspec])).split('\0').filter(Boolean)) paths.set(path, 'added')
            const files = yield* Effect.forEach(
              [...paths].sort(([a], [b]) => a.localeCompare(b)),
              ([path, status]) => fileInfo(base.path, path, taskId !== null).pipe(Effect.map((info) => ({ path, status, selectable: info.selectable })))
            )
            const pending = yield* sql`SELECT p.id, p.parent AS expectedParent, p.paths,
          CASE WHEN a.state='applying' THEN 'applying' ELSE p.state END AS state
          FROM git_change_preparations p LEFT JOIN git_change_applications a ON a.id=p.id
          WHERE p.task_id IS ${taskId} AND p.kind='user' AND (a.id IS NULL OR a.state<>'applied') ORDER BY p.created_at, p.id`.pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.Array(
                    Schema.Struct({
                      ...PendingWorkspaceSave.fields,
                      paths: Schema.fromJsonString(PendingWorkspaceSave.fields.paths)
                    })
                  )
                )
              )
            )
            if ((yield* git(base.path, ['rev-parse', 'HEAD'])).trim() !== base.head) return yield* invalid()
            return { head: base.head, registered: base.registered, files, pending }
          },
          Effect.provide(dependencies),
          Effect.mapError(storage)
        )
        const inspect = inspectTarget(null)

        /** Bounds both blob sizes before rendering a diff; external diff and textconv programs are disabled. */
        const blobSize = Effect.fn('WorkspaceChanges.blobSize')(function* (rootPath: string, tree: string, path: string) {
          const entry = (yield* git(rootPath, ['--literal-pathspecs', 'ls-tree', '-z', tree, '--', path])).split('\0').filter(Boolean)
          if (!entry.length) return 0
          if (entry.length !== 1 || !/^\d+ blob [a-f0-9]+\t/.test(entry[0]!)) return yield* invalid()
          const object = entry[0]!.slice(0, entry[0]!.indexOf('\t')).split(' ')[2]!
          return Number((yield* git(rootPath, ['cat-file', '-s', object])).trim())
        })

        /** Live previews may create unreferenced snapshot objects; retained previews always use the accepted tree. */
        const diffTarget = Effect.fn('WorkspaceChanges.diffTarget')(
          function* (taskId: string | null, input: WorkspaceDiffInput) {
            const value = yield* Schema.decodeUnknownEffect(WorkspaceDiffInput)(input, { onExcessProperty: 'error' })
            const base = yield* baseline(taskId)
            if (taskId !== null && !value.path.startsWith('wiki/')) return yield* invalid()
            let tree: string
            if (value.saveId !== null) {
              const saved = yield* journal.get(value.saveId)
              if (saved.taskId !== taskId || saved.kind !== 'user' || saved.parent !== value.expectedParent || !saved.paths.includes(value.path)) return yield* invalid()
              tree = saved.tree
            } else {
              if (base.head !== value.expectedParent) return yield* invalid()
              const info = yield* fileInfo(base.path, value.path, taskId !== null)
              if (!info.selectable) return yield* invalid()
              if (info.size > previewLimit || (yield* blobSize(base.path, value.expectedParent, value.path)) > previewLimit) return { kind: 'too-large' as const, text: '' }
              tree = (yield* snapshotGitChange({ cwd: base.path, parent: value.expectedParent, paths: [value.path] })).tree
            }
            if ((yield* blobSize(base.path, value.expectedParent, value.path)) > previewLimit || (yield* blobSize(base.path, tree, value.path)) > previewLimit)
              return { kind: 'too-large' as const, text: '' }
            const text = yield* git(base.path, [
              '--literal-pathspecs',
              'diff',
              '--no-ext-diff',
              '--no-textconv',
              '--no-color',
              '--no-renames',
              value.expectedParent,
              tree,
              '--',
              value.path
            ])
            if (value.saveId === null && (yield* git(base.path, ['rev-parse', 'HEAD'])).trim() !== value.expectedParent) return yield* invalid()
            return {
              kind: text === '' ? ('unchanged' as const) : text.includes('\nBinary files ') ? ('binary' as const) : ('text' as const),
              text
            }
          },
          Effect.provide(dependencies),
          Effect.mapError(storage)
        )
        return WorkspaceChanges.of({
          inspect,
          diff: (input) => diffTarget(null, input),
          inspectTaskWiki: (taskId) => inspectTarget(taskId),
          diffTaskWiki: (taskId, input) => diffTarget(taskId, input)
        })
      }).pipe(Effect.mapError(storage))
    )
  }
}
