import { NodeServices } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { HarnessStore } from '../harness/harness-store'
import { TaskWorktrees } from '../tasks/task-worktrees'
import { vaultDatabaseLayer } from '../vault/vault-database'
import { initializeVaultWorkspace } from '../vault/vault-workspace'
import { GitChangeApplications, isRegisteredGitCommit } from './git-change-applications'
import { makeVaultGit } from './vault-git'

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'folio-git-operation-')))
  await mkdir(join(root, 'entry'))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function layer() {
  return Layer.merge(GitChangeApplications.layer(root), TaskWorktrees.layer(root)).pipe(
    Layer.provideMerge(HarnessStore.layer(root)),
    Layer.provideMerge(vaultDatabaseLayer(root)),
    Layer.provideMerge(NodeServices.layer)
  )
}

it('saves selected files with one compact operation and leaves unselected drafts on disk', async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const workspace = yield* initializeVaultWorkspace(root, join(root, 'entry'))
    yield* Effect.promise(async () => {
      await writeFile(join(workspace.wiki, 'saved.md'), 'saved\n')
      await writeFile(join(workspace.wiki, 'draft.md'), 'draft\n')
      await writeFile(join(workspace.wiki, 'staged.md'), 'staged\n')
    })
    const git = yield* makeVaultGit
    yield* git(workspace.workspace, ['add', '--', 'wiki/staged.md'])
    const changes = yield* GitChangeApplications
    const receipt = yield* changes.save({ id: 'save', taskId: null, expectedParent: workspace.initialCommit, paths: ['wiki/saved.md'] })
    expect(receipt).toMatchObject({ id: 'save', branch: 'main', state: 'completed' })
    expect(yield* Effect.promise(() => readFile(join(workspace.wiki, 'draft.md'), 'utf8'))).toBe('draft\n')
    expect(yield* git(workspace.workspace, ['show', 'HEAD:wiki/saved.md'])).toBe('saved\n')
    expect((yield* git(workspace.workspace, ['status', '--porcelain', '--', 'wiki/draft.md'])).trim()).toContain('wiki/draft.md')
    expect((yield* git(workspace.workspace, ['diff', '--cached', '--name-only'])).trim()).toBe('wiki/staged.md')
    const sql = yield* SqlClient.SqlClient
    expect(yield* sql`SELECT id, kind, state, source_commit, target_commit, artifact_path FROM git_operations`).toMatchObject([
      { id: 'save', kind: 'save-user', state: 'completed', source_commit: workspace.initialCommit,
        target_commit: receipt.commit, artifact_path: null }
    ])
    expect(yield* isRegisteredGitCommit('main', receipt.commit, workspace.initialCommit)).toBe(true)
    expect(yield* changes.save({ id: 'save', taskId: null, expectedParent: workspace.initialCommit,
      paths: ['wiki/draft.md'] }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type='table'`
    expect(tables.map((row) => row.name)).not.toEqual(expect.arrayContaining([
      'git_change_preparations', 'git_change_applications', 'git_sync_operations', 'git_sync_resolution_inputs'
    ]))
  }).pipe(Effect.provide(layer())))
})

it('recovers a ref move whose SQLite completion receipt failed', async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const workspace = yield* initializeVaultWorkspace(root, join(root, 'entry'))
    yield* Effect.promise(() => writeFile(join(workspace.wiki, 'note.md'), 'saved once\n'))
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TRIGGER fail_receipt BEFORE UPDATE OF state ON git_operations
      WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT, 'fixture'); END`
    const changes = yield* GitChangeApplications
    expect(yield* changes.save({ id: 'recover', taskId: null, expectedParent: workspace.initialCommit,
      paths: ['wiki/note.md'] }).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
    expect(yield* changes.pending).toMatchObject([{ id: 'recover', state: 'pending' }])
    yield* sql`DROP TRIGGER fail_receipt`
    const recovered = yield* changes.recover('recover')
    expect(recovered.state).toBe('completed')
    expect(yield* changes.pending).toEqual([])
    expect((yield* sql`SELECT COUNT(*) AS count FROM git_operations`)[0]).toMatchObject({ count: 1 })
  }).pipe(Effect.provide(layer())))
})

it('refuses recovery without overwriting staging created after a lost receipt', async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const workspace = yield* initializeVaultWorkspace(root, join(root, 'entry'))
    yield* Effect.promise(() => writeFile(join(workspace.wiki, 'note.md'), 'saved once\n'))
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TRIGGER fail_receipt BEFORE UPDATE OF state ON git_operations
      WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT, 'fixture'); END`
    const changes = yield* GitChangeApplications
    expect(yield* changes.save({ id: 'recover', taskId: null, expectedParent: workspace.initialCommit,
      paths: ['wiki/note.md'] }).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
    yield* sql`DROP TRIGGER fail_receipt`
    const git = yield* makeVaultGit
    // Model a crash after the ref move but before the selected-path index transition.
    yield* git(workspace.workspace, ['read-tree', workspace.initialCommit])
    yield* Effect.promise(() => writeFile(join(workspace.wiki, 'new-stage.md'), 'keep me\n'))
    yield* git(workspace.workspace, ['add', '--', 'wiki/new-stage.md'])
    const staged = (yield* git(workspace.workspace, ['diff', '--cached', '--name-only'])).trim()
    expect(yield* changes.recover('recover').pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    expect((yield* git(workspace.workspace, ['diff', '--cached', '--name-only'])).trim()).toBe(staged)
    expect(staged).toContain('wiki/new-stage.md')
  }).pipe(Effect.provide(layer())))
})

it('derives Task branch and worktree paths instead of persisting them', async () => {
  await Effect.runPromise(Effect.gen(function* () {
    yield* initializeVaultWorkspace(root, join(root, 'entry'))
    const worktrees = yield* TaskWorktrees
    const checkout = yield* worktrees.create({ id: 'task', type: 'agent', receipt: null,
      configuration: { goal: 'test', agent: 'pi', model: null, skillIds: [], integrationIds: [], resourceIds: [] } })
    const task = yield* (yield* HarnessStore).task('task')
    expect(task).toMatchObject({ branch: 'folio/task/task', worktree: join(root, 'worktrees/task') })
    expect(checkout.path).toBe(task.worktree)
    yield* Effect.promise(() => writeFile(join(task.worktree, 'wiki/task-only.md'), 'task only\n'))
    const saved = yield* (yield* GitChangeApplications).save({ id: 'task-save', taskId: task.id,
      expectedParent: checkout.baselineCommit, paths: ['wiki/task-only.md'] })
    expect(yield* isRegisteredGitCommit(task.branch, saved.commit, checkout.baselineCommit)).toBe(true)
    expect(yield* isRegisteredGitCommit('main', saved.commit, checkout.baselineCommit)).toBe(false)
    const columns = yield* (yield* SqlClient.SqlClient)`PRAGMA table_info(tasks)`
    expect(columns.map((column) => column.name)).not.toEqual(expect.arrayContaining(['branch', 'worktree']))
  }).pipe(Effect.provide(layer())))
})
