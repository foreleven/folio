import { NodeServices } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { GitChangeApplications } from '../git/git-change-applications'
import { HarnessStore } from '../harness/harness-store'
import { RoutineStore } from '../routines/routine-store'
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
  return Layer.mergeAll(TaskGitSynchronization.layer(root), GitChangeApplications.layer(root), RoutineStore.layer).pipe(
    Layer.provideMerge(TaskWorktrees.layer(root)),
    Layer.provideMerge(HarnessStore.layer(root)),
    Layer.provideMerge(vaultDatabaseLayer(root)),
    Layer.provideMerge(NodeServices.layer)
  )
}

const setup = Effect.gen(function* () {
  const workspace = yield* initializeVaultWorkspace(root, join(root, 'entry'))
  const worktrees = yield* TaskWorktrees
  const task = yield* worktrees.create({ id: 'task', type: 'agent', receipt: null,
    configuration: { goal: 'test', agent: 'pi', model: null, skillIds: [], integrationIds: [], resourceIds: [], rawInput: null } })
  return { workspace, task, worktrees, changes: yield* GitChangeApplications,
    synchronization: yield* TaskGitSynchronization, git: yield* makeVaultGit }
})

/** Exercise the same save/prepare split as Ingestion before canonical publication. */
const prepareRaws = Effect.fnUntraced(function* () {
  const routines = yield* RoutineStore
  const routineId = '99999999-9999-4999-8999-999999999999'
  yield* routines.save({ id: routineId, expectedRevision: null, name: 'IM', type: 'ingestion',
    configuration: { integrationId: 'lark', resourceId: 'im' },
    trigger: { type: 'schedule', intervalMinutes: 60, timeZone: 'Asia/Shanghai' }, enabled: true })
  const execution = (yield* routines.schedule(routineId, Date.parse('2026-09-28T01:00:00+08:00')))!
  const ingestion = yield* (yield* TaskWorktrees).ensure(execution.taskId)
  const path = 'raws/lark/im/2026-09-28/chat.md'
  yield* Effect.promise(() => mkdir(join(ingestion.path, 'raws/lark/im/2026-09-28'), { recursive: true }))
  yield* Effect.promise(() => writeFile(join(ingestion.path, path), 'new messages\n'))
  const raw = yield* (yield* GitChangeApplications).saveTaskRaws({ id: 'raw-save', taskId: execution.taskId,
    expectedParent: ingestion.baselineCommit, paths: [path] })
  const publication = yield* (yield* TaskGitSynchronization).prepare({ id: 'raw-publish', taskId: execution.taskId,
    expectedSourceHead: raw.commit })
  return { publication, path }
})

it('publishes raws while an earlier Wiki publication is prepared', async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const { workspace, task, changes, synchronization } = yield* setup
    yield* Effect.promise(() => writeFile(join(task.path, 'wiki/note.md'), 'pending knowledge\n'))
    const wiki = yield* changes.save({ id: 'wiki-save', taskId: 'task', expectedParent: task.baselineCommit,
      paths: ['wiki/note.md'] })
    expect((yield* synchronization.prepare({ id: 'wiki-publish', taskId: 'task', expectedSourceHead: wiki.commit })).state).toBe('prepared')

    const { publication, path } = yield* prepareRaws()
    expect(publication.state).toBe('prepared')

    expect((yield* synchronization.publish('raw-publish')).state).toBe('published')
    expect(yield* Effect.promise(() => readFile(join(workspace.workspace, path), 'utf8'))).toBe('new messages\n')
    expect((yield* synchronization.get('wiki-publish')).state).toBe('prepared')
    expect((yield* synchronization.publish('wiki-publish')).state).toBe('published')
    expect(yield* Effect.promise(() => readFile(join(workspace.wiki, 'note.md'), 'utf8'))).toBe('pending knowledge\n')
    expect(yield* Effect.promise(() => readFile(join(workspace.workspace, path), 'utf8'))).toBe('new messages\n')
  }).pipe(Effect.provide(layer())))
}, 15_000)

it('publishes Wiki without waiting for an earlier raw publication', async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const { workspace, task, changes, synchronization } = yield* setup
    const { publication, path } = yield* prepareRaws()
    expect(publication.state).toBe('prepared')
    yield* Effect.promise(() => writeFile(join(task.path, 'wiki/note.md'), 'knowledge\n'))
    const wiki = yield* changes.save({ id: 'wiki-save', taskId: 'task', expectedParent: task.baselineCommit,
      paths: ['wiki/note.md'] })
    expect((yield* synchronization.synchronize({ id: 'wiki-publish', taskId: 'task', expectedSourceHead: wiki.commit })).state).toBe('completed')
    expect((yield* synchronization.get('raw-publish')).state).toBe('prepared')
    expect((yield* synchronization.publish('raw-publish')).state).toBe('published')
    expect(yield* Effect.promise(() => readFile(join(workspace.wiki, 'note.md'), 'utf8'))).toBe('knowledge\n')
    expect(yield* Effect.promise(() => readFile(join(workspace.workspace, path), 'utf8'))).toBe('new messages\n')
  }).pipe(Effect.provide(layer())))
}, 15_000)

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

it('publishes a Knowledge Task draft with one Git operation and no Task save', async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const workspace = yield* initializeVaultWorkspace(root, join(root, 'entry'))
    const worktrees = yield* TaskWorktrees
    const task = yield* worktrees.create({ id: 'knowledge', type: 'agent', receipt: null,
      configuration: { goal: 'organize', agent: 'codex', model: null, skillIds: [], integrationIds: [], resourceIds: [],
        rawInput: { fromCommit: null, toCommit: workspace.initialCommit } } })
    yield* Effect.promise(() => writeFile(join(task.path, 'wiki', 'finding.md'), '# Finding\n'))
    const synchronization = yield* TaskGitSynchronization
    expect((yield* synchronization.publishKnowledge({ id: 'knowledge-publish', taskId: 'knowledge',
      paths: ['wiki/finding.md'] })).state).toBe('completed')
    expect(yield* Effect.promise(() => readFile(join(workspace.wiki, 'finding.md'), 'utf8'))).toBe('# Finding\n')
    expect(yield* (yield* SqlClient.SqlClient)`SELECT kind, state FROM git_operations WHERE task_id='knowledge'`).toEqual([
      { kind: 'synchronize', state: 'completed' }
    ])
    expect((yield* (yield* makeVaultGit)(task.path, ['status', '--porcelain'])).trim()).toBe('')
  }).pipe(Effect.provide(layer())))
})

it('keeps a conflicting Knowledge intent at the head of the Wiki publication queue', async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const workspace = yield* initializeVaultWorkspace(root, join(root, 'entry'))
    const changes = yield* GitChangeApplications
    yield* Effect.promise(() => writeFile(join(workspace.wiki, 'shared.md'), 'base\n'))
    const base = yield* changes.save({ id: 'base', taskId: null, expectedParent: workspace.initialCommit,
      paths: ['wiki/shared.md'] })
    const task = yield* (yield* TaskWorktrees).create({ id: 'knowledge', type: 'agent', receipt: null,
      configuration: { goal: 'organize', agent: 'codex', model: null, skillIds: [], integrationIds: [], resourceIds: [],
        rawInput: { fromCommit: null, toCommit: base.commit } } })
    yield* Effect.promise(() => writeFile(join(task.path, 'wiki/shared.md'), 'knowledge\n'))
    yield* Effect.promise(() => writeFile(join(workspace.wiki, 'shared.md'), 'canonical\n'))
    yield* changes.save({ id: 'main-edit', taskId: null, expectedParent: base.commit, paths: ['wiki/shared.md'] })
    const synchronization = yield* TaskGitSynchronization
    const first = yield* synchronization.publishKnowledge({ id: 'first-intent', taskId: 'knowledge',
      paths: ['wiki/shared.md'] })
    expect(first.state).toBe('conflict')
    expect(yield* Effect.promise(() => readFile(join(workspace.wiki, 'shared.md'), 'utf8'))).toBe('canonical\n')
    const later = yield* (yield* TaskWorktrees).create({ id: 'later-knowledge', type: 'agent', receipt: null,
      configuration: { goal: 'organize', agent: 'codex', model: null, skillIds: [], integrationIds: [], resourceIds: [],
        rawInput: { fromCommit: null, toCommit: base.commit } } })
    yield* Effect.promise(() => writeFile(join(later.path, 'wiki/later.md'), 'later knowledge\n'))
    expect(yield* synchronization.publishKnowledge({ id: 'later-intent', taskId: 'later-knowledge',
      paths: ['wiki/later.md'] }).pipe(Effect.flip)).toMatchObject({ reason: 'task-busy',
      message: 'An earlier Wiki publication is still pending.' })
    const { publication, path } = yield* prepareRaws()
    expect((yield* synchronization.publish(publication.id)).state).toBe('published')
    expect(yield* Effect.promise(() => readFile(join(workspace.workspace, path), 'utf8'))).toBe('new messages\n')
    expect((yield* synchronization.get('first-intent')).state).toBe('conflict')
    expect(yield* synchronization.publish('later-intent').pipe(Effect.flip)).toMatchObject({ reason: 'task-busy' })
    const candidates = yield* synchronization.resolutionFiles('knowledge', 'first-intent')
    expect(candidates).toMatchObject([{ path: 'wiki/shared.md', canonical: 'canonical\n', task: 'knowledge\n' }])
    yield* synchronization.writeResolution({ taskId: 'knowledge', operationId: 'first-intent',
      files: [{ path: 'wiki/shared.md', content: 'merged\n' }] })
    // A lost reply after staging must still expose the same file and accept the same choice.
    expect(yield* synchronization.resolutionFiles('knowledge', 'first-intent')).toMatchObject([
      { path: 'wiki/shared.md', working: 'merged\n' }
    ])
    yield* synchronization.writeResolution({ taskId: 'knowledge', operationId: 'first-intent',
      files: [{ path: 'wiki/shared.md', content: 'merged\n' }] })
    expect((yield* synchronization.resolve('first-intent')).state).toBe('completed')
    expect((yield* synchronization.publishKnowledge({ id: 'later-intent', taskId: 'later-knowledge',
      paths: ['wiki/later.md'] })).state).toBe('completed')
    expect(yield* Effect.promise(() => readFile(join(workspace.wiki, 'shared.md'), 'utf8'))).toBe('merged\n')
    expect(yield* Effect.promise(() => readFile(join(workspace.wiki, 'later.md'), 'utf8'))).toBe('later knowledge\n')
    expect(yield* Effect.promise(() => readFile(join(workspace.workspace, path), 'utf8'))).toBe('new messages\n')
    expect(yield* (yield* SqlClient.SqlClient)`SELECT kind, state FROM git_operations WHERE task_id='knowledge'`).toEqual([
      { kind: 'synchronize', state: 'completed' }
    ])
  }).pipe(Effect.provide(layer())))
}, 15_000)

it('recovers a Knowledge publication after the Task checkout resets but its receipt fails', async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const workspace = yield* initializeVaultWorkspace(root, join(root, 'entry'))
    const task = yield* (yield* TaskWorktrees).create({ id: 'knowledge', type: 'agent', receipt: null,
      configuration: { goal: 'organize', agent: 'codex', model: null, skillIds: [], integrationIds: [], resourceIds: [],
        rawInput: { fromCommit: null, toCommit: workspace.initialCommit } } })
    yield* Effect.promise(() => writeFile(join(task.path, 'wiki', 'finding.md'), '# Finding\n'))
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TRIGGER fail_knowledge_receipt BEFORE UPDATE OF state ON git_operations
      WHEN OLD.id='knowledge-publish' AND NEW.state='completed' BEGIN SELECT RAISE(ABORT, 'receipt failed'); END`
    const synchronization = yield* TaskGitSynchronization
    expect((yield* synchronization.publishKnowledge({ id: 'knowledge-publish', taskId: 'knowledge',
      paths: ['wiki/finding.md'] }).pipe(Effect.flip)).reason).toBe('storage')
    const published = yield* synchronization.get('knowledge-publish')
    expect(published.state).toBe('published')
    // Canonical publication releases FIFO even when the prior alignment receipt failed.
    const later = yield* (yield* TaskWorktrees).create({ id: 'later-knowledge', type: 'agent', receipt: null,
      configuration: { goal: 'organize', agent: 'codex', model: null, skillIds: [], integrationIds: [], resourceIds: [],
        rawInput: { fromCommit: null, toCommit: published.publishedHead! } } })
    yield* Effect.promise(() => writeFile(join(later.path, 'wiki/later.md'), '# Later\n'))
    expect((yield* synchronization.publishKnowledge({ id: 'later-publish', taskId: 'later-knowledge',
      paths: ['wiki/later.md'] })).state).toBe('completed')
    expect((yield* synchronization.get('knowledge-publish')).state).toBe('published')
    yield* sql`DROP TRIGGER fail_knowledge_receipt`
    expect((yield* synchronization.align('knowledge-publish')).state).toBe('completed')
    expect(yield* Effect.promise(() => readFile(join(workspace.wiki, 'finding.md'), 'utf8'))).toBe('# Finding\n')
    expect(yield* Effect.promise(() => readFile(join(workspace.wiki, 'later.md'), 'utf8'))).toBe('# Later\n')
  }).pipe(Effect.provide(layer())))
}, 15_000)

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
