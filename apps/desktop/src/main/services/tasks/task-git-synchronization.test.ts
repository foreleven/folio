import { NodeServices } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { GitChangeApplications } from '../git/git-change-applications'
import { HarnessStore } from '../harness/harness-store'
import { vaultDatabaseLayer } from '../vault/vault-database'
import { initializeVaultWorkspace } from '../vault/vault-workspace'
import { makeVaultGit } from '../git/vault-git'
import { TaskGitSynchronization } from './task-git-synchronization'
import { TaskWorktrees } from './task-worktrees'

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'folio-sync-operation-')))
  await mkdir(join(root, 'entry'))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function layer() {
  return Layer.mergeAll(TaskGitSynchronization.layer(root), GitChangeApplications.layer(root), TaskWorktrees.layer(root)).pipe(
    Layer.provideMerge(HarnessStore.layer(root)),
    Layer.provideMerge(vaultDatabaseLayer(root)),
    Layer.provideMerge(NodeServices.layer)
  )
}

const setup = Effect.gen(function* () {
  const workspace = yield* initializeVaultWorkspace(root, join(root, 'entry'))
  const worktrees = yield* TaskWorktrees
  const task = yield* worktrees.create({ id: 'task', type: 'agent', receipt: null,
    configuration: { goal: 'test', agent: 'pi', model: null, skillIds: [], integrationIds: [], resourceIds: [] } })
  return { workspace, task, worktrees, changes: yield* GitChangeApplications,
    synchronization: yield* TaskGitSynchronization, git: yield* makeVaultGit }
})

it('publishes and aligns a Task through one compact synchronization operation', async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const { workspace, task, changes, synchronization, git } = yield* setup
    yield* Effect.promise(() => writeFile(join(task.path, 'wiki/note.md'), 'task knowledge\n'))
    const saved = yield* changes.save({ id: 'task-save', taskId: 'task', expectedParent: task.baselineCommit,
      paths: ['wiki/note.md'] })
    const operation = yield* synchronization.synchronize({ id: 'sync', taskId: 'task', expectedSourceHead: saved.commit })
    expect(operation).toMatchObject({ id: 'sync', taskId: 'task', sourceHead: saved.commit, state: 'completed' })
    expect(operation.publishedHead).not.toBeNull()
    expect(yield* Effect.promise(() => readFile(join(workspace.wiki, 'note.md'), 'utf8'))).toBe('task knowledge\n')
    expect((yield* git(task.path, ['rev-parse', 'HEAD'])).trim()).toBe((yield* git(workspace.workspace, ['rev-parse', 'HEAD'])).trim())
    const sql = yield* SqlClient.SqlClient
    expect(yield* sql`SELECT kind, state, artifact_path FROM git_operations WHERE id='sync'`).toEqual([
      { kind: 'synchronize', state: 'completed', artifact_path: null }
    ])
  }).pipe(Effect.provide(layer())))
})

it('rebuilds a prepared Task layer when main advances before publication', async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const { workspace, task, changes, synchronization } = yield* setup
    yield* Effect.promise(() => writeFile(join(task.path, 'wiki/task.md'), 'task\n'))
    const taskSave = yield* changes.save({ id: 'task-save', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/task.md'] })
    expect(yield* synchronization.prepare({ id: 'sync', taskId: 'task', expectedSourceHead: taskSave.commit })).toMatchObject({ state: 'prepared' })
    yield* Effect.promise(() => writeFile(join(workspace.wiki, 'main.md'), 'main\n'))
    yield* changes.save({ id: 'main-save', taskId: null, expectedParent: workspace.initialCommit, paths: ['wiki/main.md'] })
    const published = yield* synchronization.publish('sync')
    expect(published.state).toBe('published')
    expect((yield* synchronization.align('sync')).state).toBe('completed')
    expect(yield* Effect.promise(() => readFile(join(workspace.wiki, 'task.md'), 'utf8'))).toBe('task\n')
    expect(yield* Effect.promise(() => readFile(join(workspace.wiki, 'main.md'), 'utf8'))).toBe('main\n')
  }).pipe(Effect.provide(layer())))
}, 15_000)

it('recovers a pending rebuild whose refreshed main checkpoint was not written', async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const { workspace, task, changes, synchronization } = yield* setup
    yield* Effect.promise(() => writeFile(join(task.path, 'wiki/task.md'), 'task\n'))
    const taskSave = yield* changes.save({ id: 'task-save', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/task.md'] })
    expect(yield* synchronization.prepare({ id: 'sync', taskId: 'task', expectedSourceHead: taskSave.commit })).toMatchObject({ state: 'prepared' })
    yield* Effect.promise(() => writeFile(join(workspace.wiki, 'main.md'), 'main\n'))
    yield* changes.save({ id: 'main-save', taskId: null, expectedParent: workspace.initialCommit, paths: ['wiki/main.md'] })
    // This is the crash boundary in publish: SQLite moved back to pending while operation.json
    // still names the older main baseline.
    yield* (yield* SqlClient.SqlClient)`UPDATE git_operations SET state='pending', target_commit=NULL WHERE id='sync'`
    expect(yield* synchronization.prepare({ id: 'sync', taskId: 'task', expectedSourceHead: taskSave.commit })).toMatchObject({ state: 'prepared' })
    expect((yield* synchronization.publish('sync')).state).toBe('published')
    expect((yield* synchronization.align('sync')).state).toBe('completed')
  }).pipe(Effect.provide(layer())))
}, 15_000)

it('keeps genuine same-file wiki conflicts in a local operation directory', async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const { workspace, changes, synchronization } = yield* setup
    yield* Effect.promise(() => writeFile(join(workspace.wiki, 'note.md'), 'base\n'))
    const baseline = yield* changes.save({ id: 'baseline', taskId: null, expectedParent: workspace.initialCommit, paths: ['wiki/note.md'] })
    // Start a fresh Task generation from the registered baseline.
    yield* (yield* TaskWorktrees).complete('task')
    yield* (yield* TaskWorktrees).reopen('task')
    const reopened = yield* (yield* HarnessStore).task('task')
    yield* Effect.promise(() => writeFile(join(reopened.worktree, 'wiki/note.md'), 'task version\n'))
    const taskSave = yield* changes.save({ id: 'task-save', taskId: 'task', expectedParent: baseline.commit, paths: ['wiki/note.md'] })
    yield* Effect.promise(() => writeFile(join(workspace.wiki, 'note.md'), 'main version\n'))
    yield* changes.save({ id: 'main-save', taskId: null, expectedParent: baseline.commit, paths: ['wiki/note.md'] })
    const operation = yield* synchronization.prepare({ id: 'conflict', taskId: 'task', expectedSourceHead: taskSave.commit })
    expect(operation.state).toBe('conflict')
    expect(yield* Effect.promise(() => readFile(join(root, 'git-operations/conflict/operation.json'), 'utf8'))).toContain('"conflictIndex": 0')
    expect(yield* (yield* SqlClient.SqlClient)`SELECT name FROM sqlite_master WHERE name='git_sync_resolution_inputs'`).toEqual([])
    expect((yield* synchronization.abort('conflict')).state).toBe('aborted')
  }).pipe(Effect.provide(layer())))
})

it('replays source commits after a resolved conflict before publishing', async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const { workspace, changes, synchronization, git } = yield* setup
    yield* Effect.promise(() => writeFile(join(workspace.wiki, 'note.md'), 'base\n'))
    const baseline = yield* changes.save({ id: 'baseline', taskId: null, expectedParent: workspace.initialCommit, paths: ['wiki/note.md'] })
    yield* (yield* TaskWorktrees).complete('task')
    yield* (yield* TaskWorktrees).reopen('task')
    const reopened = yield* (yield* HarnessStore).task('task')
    yield* Effect.promise(() => writeFile(join(reopened.worktree, 'wiki/note.md'), 'task version\n'))
    const first = yield* changes.save({ id: 'task-first', taskId: 'task', expectedParent: baseline.commit, paths: ['wiki/note.md'] })
    yield* Effect.promise(() => writeFile(join(reopened.worktree, 'wiki/later.md'), 'later commit\n'))
    const second = yield* changes.save({ id: 'task-second', taskId: 'task', expectedParent: first.commit, paths: ['wiki/later.md'] })
    yield* Effect.promise(() => writeFile(join(reopened.worktree, 'wiki/later.md'), 'later final\n'))
    const third = yield* changes.save({ id: 'task-third', taskId: 'task', expectedParent: second.commit, paths: ['wiki/later.md'] })
    yield* Effect.promise(() => writeFile(join(workspace.wiki, 'note.md'), 'main version\n'))
    yield* changes.save({ id: 'main-save', taskId: null, expectedParent: baseline.commit, paths: ['wiki/note.md'] })
    expect(yield* synchronization.prepare({ id: 'conflict', taskId: 'task', expectedSourceHead: third.commit })).toMatchObject({ state: 'conflict' })
    const coordinator = yield* synchronization.resolutionDirectory('task', 'conflict')
    yield* Effect.promise(() => writeFile(join(coordinator, 'wiki/note.md'), 'resolved\n'))
    yield* git(coordinator, ['add', '--', 'wiki/note.md'])
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TRIGGER fail_prepared_receipt BEFORE UPDATE OF state ON git_operations
      WHEN OLD.state='conflict' AND NEW.state='prepared' BEGIN SELECT RAISE(ABORT, 'lost prepared receipt'); END`
    const failedReceipt = yield* Effect.exit(synchronization.resolve('conflict'))
    expect(failedReceipt._tag).toBe('Failure')
    yield* sql`DROP TRIGGER fail_prepared_receipt`
    expect((yield* synchronization.resolve('conflict')).state).toBe('completed')
    expect(yield* Effect.promise(() => readFile(join(workspace.wiki, 'note.md'), 'utf8'))).toBe('resolved\n')
    expect(yield* Effect.promise(() => readFile(join(workspace.wiki, 'later.md'), 'utf8'))).toBe('later final\n')
  }).pipe(Effect.provide(layer())))
}, 15_000)

it('does not replay source commits already represented by a rebased resolution patch', async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const { workspace, changes, synchronization, git } = yield* setup
    yield* Effect.promise(() => writeFile(join(workspace.wiki, 'note.md'), 'base\n'))
    const baseline = yield* changes.save({ id: 'baseline', taskId: null, expectedParent: workspace.initialCommit, paths: ['wiki/note.md'] })
    yield* (yield* TaskWorktrees).complete('task')
    yield* (yield* TaskWorktrees).reopen('task')
    const reopened = yield* (yield* HarnessStore).task('task')
    yield* Effect.promise(() => writeFile(join(reopened.worktree, 'wiki/note.md'), 'task version\n'))
    const first = yield* changes.save({ id: 'task-first', taskId: 'task', expectedParent: baseline.commit, paths: ['wiki/note.md'] })
    yield* Effect.promise(() => writeFile(join(reopened.worktree, 'wiki/later.md'), 'task later\n'))
    const second = yield* changes.save({ id: 'task-second', taskId: 'task', expectedParent: first.commit, paths: ['wiki/later.md'] })
    yield* Effect.promise(() => writeFile(join(workspace.wiki, 'note.md'), 'main version\n'))
    const mainFirst = yield* changes.save({ id: 'main-first', taskId: null, expectedParent: baseline.commit, paths: ['wiki/note.md'] })
    expect(yield* synchronization.prepare({ id: 'conflict', taskId: 'task', expectedSourceHead: second.commit })).toMatchObject({ state: 'conflict' })
    const coordinator = yield* synchronization.resolutionDirectory('task', 'conflict')
    yield* Effect.promise(() => writeFile(join(coordinator, 'wiki/note.md'), 'resolved note\n'))
    yield* git(coordinator, ['add', '--', 'wiki/note.md'])
    // A dirty main stops the automatic publication after the accepted aggregate patch
    // has become the operation's durable prepared input.
    yield* Effect.promise(() => writeFile(join(workspace.wiki, 'later.md'), 'main later\n'))
    const failedPublish = yield* Effect.exit(synchronization.resolve('conflict'))
    expect(failedPublish._tag).toBe('Failure')
    yield* changes.save({ id: 'main-second', taskId: null, expectedParent: mainFirst.commit, paths: ['wiki/later.md'] })
    expect(yield* synchronization.publish('conflict')).toMatchObject({ state: 'conflict' })
    const rebased = yield* synchronization.resolutionDirectory('task', 'conflict')
    yield* Effect.promise(() => writeFile(join(rebased, 'wiki/later.md'), 'chosen later\n'))
    yield* git(rebased, ['add', '--', 'wiki/later.md'])
    expect(yield* synchronization.resolve('conflict')).toMatchObject({ state: 'completed' })
    expect(yield* Effect.promise(() => readFile(join(workspace.wiki, 'later.md'), 'utf8'))).toBe('chosen later\n')
  }).pipe(Effect.provide(layer())))
}, 20_000)

it('recovers alignment after its reset receipt is lost and main advances again', async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const { workspace, task, changes, synchronization, git } = yield* setup
    yield* Effect.promise(() => writeFile(join(task.path, 'wiki/task.md'), 'task\n'))
    const taskSave = yield* changes.save({ id: 'task-save', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/task.md'] })
    expect(yield* synchronization.prepare({ id: 'sync', taskId: 'task', expectedSourceHead: taskSave.commit })).toMatchObject({ state: 'prepared' })
    expect(yield* synchronization.publish('sync')).toMatchObject({ state: 'published' })
    const publishedMain = (yield* git(workspace.workspace, ['rev-parse', 'HEAD'])).trim()
    yield* Effect.promise(() => writeFile(join(workspace.wiki, 'first.md'), 'first\n'))
    const first = yield* changes.save({ id: 'main-first', taskId: null, expectedParent: publishedMain, paths: ['wiki/first.md'] })
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TRIGGER fail_alignment BEFORE UPDATE OF state ON git_operations
      WHEN OLD.state='published' AND NEW.state='completed' BEGIN SELECT RAISE(ABORT, 'crash after reset'); END`
    const failedAlignment = yield* Effect.exit(synchronization.align('sync'))
    expect(failedAlignment._tag).toBe('Failure')
    expect((yield* git(task.path, ['rev-parse', 'HEAD'])).trim()).toBe(first.commit)
    yield* sql`DROP TRIGGER fail_alignment`
    yield* Effect.promise(() => writeFile(join(workspace.wiki, 'second.md'), 'second\n'))
    yield* changes.save({ id: 'main-second', taskId: null, expectedParent: first.commit, paths: ['wiki/second.md'] })
    expect(yield* synchronization.align('sync')).toMatchObject({ state: 'completed', publishedHead: first.commit })
    expect((yield* git(task.path, ['rev-parse', 'HEAD'])).trim()).toBe(first.commit)
  }).pipe(Effect.provide(layer())))
}, 20_000)

it('refuses to align a Task to an unregistered external main commit', async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const { workspace, task, changes, synchronization, git } = yield* setup
    yield* Effect.promise(() => writeFile(join(task.path, 'wiki/task.md'), 'task\n'))
    const taskSave = yield* changes.save({ id: 'task-save', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/task.md'] })
    expect(yield* synchronization.prepare({ id: 'sync', taskId: 'task', expectedSourceHead: taskSave.commit })).toMatchObject({ state: 'prepared' })
    expect(yield* synchronization.publish('sync')).toMatchObject({ state: 'published' })
    yield* Effect.promise(() => writeFile(join(workspace.wiki, 'external.md'), 'external\n'))
    yield* git(workspace.workspace, ['add', '--', 'wiki/external.md'])
    yield* git(workspace.workspace, ['commit', '-m', 'external commit'])
    const failedAlignment = yield* Effect.exit(synchronization.align('sync'))
    expect(failedAlignment._tag).toBe('Failure')
    expect((yield* git(task.path, ['rev-parse', 'HEAD'])).trim()).toBe(taskSave.commit)
  }).pipe(Effect.provide(layer())))
})
