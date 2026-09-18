import { reserveClaimedRun, finishClaimedRun } from './testing/claimed-run'
import { NodeServices } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { GitChangeApplications, isRegisteredGitCommit } from './git-change-applications'
import { GitChangeJournal } from './git-change-journal'
import { HarnessStore } from './harness-store'
import { TaskGitSynchronization } from './task-git-synchronization'
import { TaskWorktrees } from './task-worktrees'
import { vaultDatabaseLayer } from './vault-database'
import { makeVaultGit } from './vault-git'
import { VaultGitWriteLock } from './vault-git-write-lock'
import { initializeVaultWorkspace } from './vault-workspace'

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'folio-task-sync-')))
  await mkdir(join(root, 'entry'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function layer() {
  return Layer.mergeAll(TaskGitSynchronization.layer(root), GitChangeApplications.layer(root), TaskWorktrees.layer(root), VaultGitWriteLock.layer(root)).pipe(
    Layer.provideMerge(GitChangeJournal.layer(root)),
    Layer.provideMerge(HarnessStore.layer),
    Layer.provideMerge(vaultDatabaseLayer(root)),
    Layer.provideMerge(NodeServices.layer)
  )
}

const setup = Effect.gen(function* () {
  const workspace = yield* initializeVaultWorkspace(root, join(root, 'entry'))
  const worktrees = yield* TaskWorktrees
  const task = yield* worktrees.create({ id: 'task', goal: 'manual wiki validation', configuration: { agent: 'pi', skillIds: [], integrationIds: [] } })
  return {
    workspace,
    task,
    worktrees,
    store: yield* HarnessStore,
    git: yield* makeVaultGit,
    applications: yield* GitChangeApplications,
    sync: yield* TaskGitSynchronization
  }
})

/** Manual writes stand in for a stopped Agent; this test intentionally does not claim writer quiescence. */
it('publishes a manually saved wiki change and keeps later rounds on the aligned frontier', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { workspace, task, applications, sync, git } = yield* setup
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/note.md'), 'first task edit\n'))
      const firstSource = yield* applications.save({ id: 'task-save-1', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/note.md'] })
      const first = yield* sync.synchronize({ id: 'sync-1', taskId: 'task', expectedSourceHead: firstSource.commit })
      expect(first).toMatchObject({ state: 'aligned', sourceFrontier: task.baselineCommit, sourceHead: firstSource.commit, sourceChanges: ['task-save-1'] })
      expect(yield* Effect.promise(() => readFile(join(workspace.workspace, 'wiki/note.md'), 'utf8'))).toBe('first task edit\n')
      expect((yield* git(task.path, ['merge-base', '--is-ancestor', firstSource.commit, 'HEAD'])).trim()).toBe('')
      expect((yield* git(task.path, ['rev-parse', 'HEAD^{tree}'])).trim()).toBe((yield* git(workspace.workspace, ['rev-parse', 'HEAD^{tree}'])).trim())
      expect(yield* isRegisteredGitCommit(task.branch, first.alignedHead!, task.baselineCommit)).toBe(true)
      expect(yield* sync.synchronize({ id: 'sync-1', taskId: 'task', expectedSourceHead: firstSource.commit })).toEqual(first)

      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/note.md'), 'second task edit\n'))
      const secondSource = yield* applications.save({ id: 'task-save-2', taskId: 'task', expectedParent: first.alignedHead!, paths: ['wiki/note.md'] })
      const second = yield* sync.synchronize({ id: 'sync-2', taskId: 'task', expectedSourceHead: secondSource.commit })
      expect(second).toMatchObject({ state: 'aligned', sourceFrontier: first.alignedHead, sourceHead: secondSource.commit, sourceChanges: ['task-save-2'] })
      expect(yield* Effect.promise(() => readFile(join(workspace.workspace, 'wiki/note.md'), 'utf8'))).toBe('second task edit\n')
      expect((yield* git(task.path, ['rev-parse', 'HEAD^{tree}'])).trim()).toBe((yield* git(workspace.workspace, ['rev-parse', 'HEAD^{tree}'])).trim())
    }).pipe(Effect.provide(layer()))
  )
}, 20_000)

it('reopens an aligned Task on an advanced main and starts a fresh sync frontier', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { workspace, task, worktrees, applications, sync, git } = yield* setup
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/first.md'), 'first task edit\n'))
      const firstSource = yield* applications.save({ id: 'reopen-first-save', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/first.md'] })
      const first = yield* sync.synchronize({ id: 'reopen-first-sync', taskId: 'task', expectedSourceHead: firstSource.commit })
      expect(first.state).toBe('aligned')
      yield* worktrees.complete('task')

      // Main advances after release, as another user/task may publish a registered change.
      yield* Effect.promise(() => writeFile(join(workspace.workspace, 'wiki/main-after-release.md'), 'main change\n'))
      const mainSource = yield* applications.save({ id: 'reopen-main-save', taskId: null, expectedParent: first.publishedHead!, paths: ['wiki/main-after-release.md'] })
      const mainHead = mainSource.commit
      const reopened = yield* worktrees.reopen('task')
      expect(reopened.baselineCommit).toBe(mainHead)
      expect((yield* git(reopened.path, ['rev-parse', 'HEAD'])).trim()).toBe(mainHead)

      // A new manual save must start at the reopened base, not traverse the old aligned history.
      yield* Effect.promise(() => writeFile(join(reopened.path, 'wiki/second.md'), 'second task edit\n'))
      const secondSource = yield* applications.save({ id: 'reopen-second-save', taskId: 'task', expectedParent: mainHead, paths: ['wiki/second.md'] })
      const second = yield* sync.synchronize({ id: 'reopen-second-sync', taskId: 'task', expectedSourceHead: secondSource.commit })
      expect(second).toMatchObject({ state: 'aligned', sourceFrontier: mainHead, sourceHead: secondSource.commit })
      expect((yield* git(workspace.workspace, ['rev-parse', 'HEAD'])).trim()).toBe(second.publishedHead)
      expect(yield* Effect.promise(() => readFile(join(workspace.workspace, 'wiki/main-after-release.md'), 'utf8'))).toBe('main change\n')
      expect(yield* Effect.promise(() => readFile(join(workspace.workspace, 'wiki/second.md'), 'utf8'))).toBe('second task edit\n')
    }).pipe(Effect.provide(layer()))
  )
}, 20_000)

it('keeps a same-file conflict outside main and retains both source checkouts unchanged', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { workspace, task, applications, sync, git } = yield* setup
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/note.md'), 'task version\n'))
      const taskSource = yield* applications.save({ id: 'task-change', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/note.md'] })
      yield* Effect.promise(() => writeFile(join(workspace.workspace, 'wiki/note.md'), 'main version\n'))
      const mainSource = yield* applications.save({ id: 'main-change', taskId: null, expectedParent: task.baselineCommit, paths: ['wiki/note.md'] })
      const operation = yield* sync.prepare({ id: 'conflict-sync', taskId: 'task', expectedSourceHead: taskSource.commit })
      expect(operation).toMatchObject({ state: 'conflict', mainBase: mainSource.commit, sourceHead: taskSource.commit })
      expect((yield* git(workspace.workspace, ['rev-parse', 'HEAD'])).trim()).toBe(mainSource.commit)
      expect((yield* git(task.path, ['rev-parse', 'HEAD'])).trim()).toBe(taskSource.commit)
      expect((yield* git(workspace.workspace, ['status', '--porcelain'])).trim()).toBe('')
      expect(yield* Effect.promise(() => readFile(join(workspace.workspace, 'wiki/note.md'), 'utf8'))).toBe('main version\n')
      expect(yield* Effect.promise(() => readFile(join(task.path, 'wiki/note.md'), 'utf8'))).toBe('task version\n')
      expect(yield* sync.pending).toMatchObject([{ id: 'conflict-sync', state: 'conflict' }])
      expect(yield* sync.publish(operation.id).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    }).pipe(Effect.provide(layer()))
  )
}, 15_000)

it('publishes one staged coordinator resolution and converges main with the Task', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { workspace, task, applications, sync, git } = yield* setup
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/note.md'), 'task version\n'))
      const taskSource = yield* applications.save({ id: 'resolved-task-change', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/note.md'] })
      yield* Effect.promise(() => writeFile(join(workspace.workspace, 'wiki/note.md'), 'main version\n'))
      yield* applications.save({ id: 'resolved-main-change', taskId: null, expectedParent: task.baselineCommit, paths: ['wiki/note.md'] })
      const operation = yield* sync.prepare({ id: 'resolved-conflict-sync', taskId: 'task', expectedSourceHead: taskSource.commit })
      expect(operation).toMatchObject({ state: 'conflict', canonicalCommits: [] })

      const coordinator = join(root, 'sync-worktrees', operation.id)
      yield* Effect.promise(() => writeFile(join(coordinator, 'wiki/note.md'), 'main version\ntask version\n'))
      yield* git(coordinator, ['add', '--', 'wiki/note.md'])

      const resolved = yield* sync.resolve(operation.id)
      expect(resolved).toMatchObject({ state: 'aligned', sourceHead: taskSource.commit })
      expect(resolved.canonicalCommits).toHaveLength(1)
      expect(yield* Effect.promise(() => readFile(join(workspace.workspace, 'wiki/note.md'), 'utf8'))).toBe('main version\ntask version\n')
      expect(yield* Effect.promise(() => readFile(join(task.path, 'wiki/note.md'), 'utf8'))).toBe('main version\ntask version\n')
      expect((yield* git(workspace.workspace, ['rev-parse', 'HEAD^{tree}'])).trim()).toBe((yield* git(task.path, ['rev-parse', 'HEAD^{tree}'])).trim())
      expect(yield* sync.resolve(operation.id)).toEqual(resolved)
    }).pipe(Effect.provide(layer()))
  )
}, 15_000)

it('keeps conflict evidence and staged validation limited to literal file names', async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const { workspace, task, applications, sync, git } = yield* setup
    const selected = 'wiki/[draft].md'
    const unrelated = 'wiki/d.md'
    yield* Effect.promise(() => writeFile(join(task.path, selected), 'task version\n'))
    const source = yield* applications.save({ id: 'literal-task', taskId: 'task', expectedParent: task.baselineCommit, paths: [selected] })
    yield* Effect.promise(async () => {
      await writeFile(join(workspace.workspace, selected), 'main version\n')
      await writeFile(join(workspace.workspace, unrelated), 'unrelated executable\n')
      await chmod(join(workspace.workspace, unrelated), 0o755)
    })
    yield* applications.save({ id: 'literal-main', taskId: null, expectedParent: task.baselineCommit, paths: [selected, unrelated] })
    const operation = yield* sync.prepare({ id: 'literal-conflict', taskId: 'task', expectedSourceHead: source.commit })
    expect(operation.state).toBe('conflict')
    const context = yield* sync.resolutionContext('task', operation.id)
    expect(context.files).toEqual([selected])
    expect(context.canonicalDiff).toContain('+main version')
    expect(context.canonicalDiff).not.toContain('unrelated executable')
    expect(context.taskDiff).toContain('+task version')
    yield* Effect.promise(() => writeFile(join(context.directory, selected), 'resolved version\n'))
    yield* git(context.directory, ['--literal-pathspecs', 'add', '--', selected])
    expect((yield* sync.resolve(operation.id)).state).toBe('aligned')
    expect(yield* Effect.promise(() => readFile(join(workspace.workspace, unrelated), 'utf8'))).toBe('unrelated executable\n')
    expect(yield* Effect.promise(() => readFile(join(workspace.workspace, selected), 'utf8'))).toBe('resolved version\n')
  }).pipe(Effect.provide(layer())))
}, 15_000)

it('accepts an ended conflict Run by staging its file-only coordinator result', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { workspace, task, applications, sync, git, store } = yield* setup
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/note.md'), 'task version\n'))
      const taskSource = yield* applications.save({ id: 'agent-task-change', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/note.md'] })
      yield* Effect.promise(() => writeFile(join(workspace.workspace, 'wiki/note.md'), 'main version\n'))
      yield* applications.save({ id: 'agent-main-change', taskId: null, expectedParent: task.baselineCommit, paths: ['wiki/note.md'] })
      const operation = yield* sync.prepare({ id: 'agent-conflict-sync', taskId: 'task', expectedSourceHead: taskSource.commit })
      yield* sync.resolutionDirectory('task', operation.id)
      const context = yield* sync.resolutionContext('task', operation.id)
      expect(context.directory).toBe(join(root, 'sync-worktrees', operation.id))
      expect(context.files).toEqual(['wiki/note.md'])
      expect(context.canonicalDiff).toContain('+main version')
      expect(context.taskDiff).toContain('+task version')

      yield* store.createSession({ id: 'conflict-session', taskId: 'task', agent: 'pi', adapterVersion: 'fixture',
        purpose: 'conflict-resolution', syncOperationId: operation.id })
      yield* store.bindSession('conflict-session', { acpSessionId: 'conflict-acp', nativeSessionId: null })
      yield* reserveClaimedRun({ id: 'conflict-run', taskId: 'task', sessionId: 'conflict-session', prompt: 'resolve',
        purpose: 'conflict-resolution', resumesRunId: null, baselineCommit: operation.mainBase })
      yield* finishClaimedRun('conflict-run', 'succeeded')
      expect((yield* store.runs('task')).at(-1)).toMatchObject({ purpose: 'conflict-resolution', syncState: 'not-required' })
      expect(yield* sync.acceptAgentResolution('task', operation.id, 'unknown').pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })

      yield* Effect.promise(() => writeFile(join(context.directory, 'wiki/note.md'), 'main version\ntask version\n'))
      const resolved = yield* sync.acceptAgentResolution('task', operation.id, 'conflict-run')
      expect(resolved.state).toBe('aligned')
      expect(yield* Effect.promise(() => readFile(join(workspace.workspace, 'wiki/note.md'), 'utf8'))).toBe('main version\ntask version\n')
      expect(yield* Effect.promise(() => readFile(join(task.path, 'wiki/note.md'), 'utf8'))).toBe('main version\ntask version\n')
      expect((yield* git(workspace.workspace, ['rev-parse', 'HEAD^{tree}'])).trim()).toBe((yield* git(task.path, ['rev-parse', 'HEAD^{tree}'])).trim())
    }).pipe(Effect.provide(layer()))
  )
}, 20_000)

it('retries conflict Run post-processing after a lost publish receipt', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { workspace, task, applications, sync, git, store } = yield* setup
      const sql = yield* SqlClient.SqlClient
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/terminal-retry.md'), 'task result\n'))
      const source = yield* applications.save({ id: 'terminal-retry-task-save', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/terminal-retry.md'] })
      yield* Effect.promise(() => writeFile(join(workspace.workspace, 'wiki/terminal-retry.md'), 'main result\n'))
      yield* applications.save({ id: 'terminal-retry-main-save', taskId: null, expectedParent: task.baselineCommit, paths: ['wiki/terminal-retry.md'] })
      const operation = yield* sync.prepare({ id: 'terminal-retry-operation', taskId: 'task', expectedSourceHead: source.commit })
      const coordinator = join(root, 'sync-worktrees', operation.id)
      yield* Effect.promise(() => writeFile(join(coordinator, 'wiki/terminal-retry.md'), 'main result\ntask result\n'))

      yield* store.createSession({ id: 'terminal-retry-session', taskId: 'task', agent: 'pi', adapterVersion: 'fixture',
        purpose: 'conflict-resolution', syncOperationId: operation.id })
      yield* store.bindSession('terminal-retry-session', { acpSessionId: 'terminal-retry-acp', nativeSessionId: null })
      yield* reserveClaimedRun({ id: 'terminal-retry-run', taskId: 'task', sessionId: 'terminal-retry-session', prompt: 'resolve',
        purpose: 'conflict-resolution', resumesRunId: null, baselineCommit: operation.mainBase })
      yield* finishClaimedRun('terminal-retry-run', 'succeeded')

      // Simulate a process loss after the canonical Git commit has moved main but before the
      // terminal acceptance receipt can be persisted. The Run itself stays durably succeeded.
      yield* sql`CREATE TRIGGER fail_terminal_publish BEFORE UPDATE OF state ON git_sync_operations
        WHEN OLD.id='terminal-retry-operation' AND NEW.state='published' BEGIN SELECT RAISE(ABORT, 'lost terminal receipt'); END`
      expect(yield* sync.acceptAgentResolution('task', operation.id, 'terminal-retry-run').pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
      expect((yield* git(workspace.workspace, ['rev-parse', 'HEAD'])).trim()).not.toBe(task.baselineCommit)
      expect(yield* sync.get(operation.id)).toMatchObject({ state: 'prepared' })
      expect((yield* store.runs('task')).find(run => run.id === 'terminal-retry-run')).toMatchObject({ state: 'succeeded' })

      yield* sql`DROP TRIGGER fail_terminal_publish`
      const recovered = yield* sync.acceptAgentResolution('task', operation.id, 'terminal-retry-run')
      expect(recovered.state).toBe('aligned')
      expect((yield* git(workspace.workspace, ['show', 'HEAD:wiki/terminal-retry.md']))).toBe('main result\ntask result\n')
      expect((yield* git(task.path, ['rev-parse', 'HEAD^{tree}'])).trim()).toBe((yield* git(workspace.workspace, ['rev-parse', 'HEAD^{tree}'])).trim())
    }).pipe(Effect.provide(layer()))
  )
}, 20_000)

it('retries conflict Run post-processing after a lost alignment receipt', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { workspace, task, applications, sync, git, store } = yield* setup
      const sql = yield* SqlClient.SqlClient
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/alignment-retry.md'), 'task result\n'))
      const source = yield* applications.save({ id: 'alignment-retry-task-save', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/alignment-retry.md'] })
      yield* Effect.promise(() => writeFile(join(workspace.workspace, 'wiki/alignment-retry.md'), 'main result\n'))
      yield* applications.save({ id: 'alignment-retry-main-save', taskId: null, expectedParent: task.baselineCommit, paths: ['wiki/alignment-retry.md'] })
      const operation = yield* sync.prepare({ id: 'alignment-retry-operation', taskId: 'task', expectedSourceHead: source.commit })
      const coordinator = join(root, 'sync-worktrees', operation.id)
      yield* Effect.promise(() => writeFile(join(coordinator, 'wiki/alignment-retry.md'), 'main result\ntask result\n'))

      yield* store.createSession({ id: 'alignment-retry-session', taskId: 'task', agent: 'pi', adapterVersion: 'fixture',
        purpose: 'conflict-resolution', syncOperationId: operation.id })
      yield* store.bindSession('alignment-retry-session', { acpSessionId: 'alignment-retry-acp', nativeSessionId: null })
      yield* reserveClaimedRun({ id: 'alignment-retry-run', taskId: 'task', sessionId: 'alignment-retry-session', prompt: 'resolve',
        purpose: 'conflict-resolution', resumesRunId: null, baselineCommit: operation.mainBase })
      yield* finishClaimedRun('alignment-retry-run', 'succeeded')

      // Simulate a process loss after the Task checkout has advanced but before the final receipt.
      yield* sql`CREATE TRIGGER fail_terminal_align BEFORE UPDATE OF state ON git_sync_operations
        WHEN OLD.id='alignment-retry-operation' AND NEW.state='aligned' BEGIN SELECT RAISE(ABORT, 'lost terminal receipt'); END`
      expect(yield* sync.acceptAgentResolution('task', operation.id, 'alignment-retry-run').pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
      expect(yield* sync.get(operation.id)).toMatchObject({ state: 'aligning' })
      expect((yield* git(task.path, ['rev-parse', 'HEAD'])).trim()).not.toBe(task.baselineCommit)
      expect((yield* git(workspace.workspace, ['rev-parse', 'HEAD'])).trim()).not.toBe(task.baselineCommit)
      expect((yield* git(task.path, ['rev-parse', 'HEAD^{tree}'])).trim()).toBe((yield* git(workspace.workspace, ['rev-parse', 'HEAD^{tree}'])).trim())

      yield* sql`DROP TRIGGER fail_terminal_align`
      const recovered = yield* sync.acceptAgentResolution('task', operation.id, 'alignment-retry-run')
      expect(recovered.state).toBe('aligned')
      expect(yield* Effect.promise(() => readFile(join(workspace.workspace, 'wiki/alignment-retry.md'), 'utf8'))).toBe('main result\ntask result\n')
    }).pipe(Effect.provide(layer()))
  )
}, 20_000)

it('retains a canonical prefix across restart and continues commits after the resolved conflict', async () => {
  const frozen = await Effect.runPromise(
    Effect.gen(function* () {
      const { workspace, task, applications, sync } = yield* setup
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/before.md'), 'before conflict\n'))
      const before = yield* applications.save({ id: 'prefix-before-save', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/before.md'] })
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/note.md'), 'task conflict\n'))
      const conflict = yield* applications.save({ id: 'prefix-conflict-save', taskId: 'task', expectedParent: before.commit, paths: ['wiki/note.md'] })
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/after.md'), 'after conflict\n'))
      const after = yield* applications.save({ id: 'prefix-after-save', taskId: 'task', expectedParent: conflict.commit, paths: ['wiki/after.md'] })
      yield* Effect.promise(() => writeFile(join(workspace.workspace, 'wiki/note.md'), 'main conflict\n'))
      yield* applications.save({ id: 'prefix-main-save', taskId: null, expectedParent: task.baselineCommit, paths: ['wiki/note.md'] })
      const operation = yield* sync.prepare({ id: 'prefix-conflict-sync', taskId: 'task', expectedSourceHead: after.commit })
      expect(operation).toMatchObject({ state: 'conflict', conflictIndex: 1 })
      expect(operation.canonicalCommits.map((item) => item.sourceChangeId)).toEqual(['prefix-before-save'])
      return { operation, sourceHead: after.commit, taskPath: task.path, mainPath: workspace.workspace }
    }).pipe(Effect.provide(layer()))
  )

  await Effect.runPromise(
    Effect.gen(function* () {
      const sync = yield* TaskGitSynchronization
      const git = yield* makeVaultGit
      const coordinator = join(root, 'sync-worktrees', frozen.operation.id)
      yield* Effect.promise(() => writeFile(join(coordinator, 'wiki/note.md'), 'main conflict\ntask conflict\n'))
      yield* git(coordinator, ['add', '--', 'wiki/note.md'])
      const resolved = yield* sync.resolve(frozen.operation.id)
      expect(resolved).toMatchObject({ state: 'aligned', sourceHead: frozen.sourceHead, conflictIndex: null })
      expect(resolved.canonicalCommits.map((item) => item.sourceChangeId)).toEqual([
        'prefix-before-save',
        'prefix-conflict-save',
        'prefix-after-save'
      ])
      expect(yield* Effect.promise(() => readFile(join(frozen.mainPath, 'wiki/before.md'), 'utf8'))).toBe('before conflict\n')
      expect(yield* Effect.promise(() => readFile(join(frozen.mainPath, 'wiki/note.md'), 'utf8'))).toBe('main conflict\ntask conflict\n')
      expect(yield* Effect.promise(() => readFile(join(frozen.mainPath, 'wiki/after.md'), 'utf8'))).toBe('after conflict\n')
      expect((yield* git(frozen.mainPath, ['rev-parse', 'HEAD^{tree}'])).trim()).toBe((yield* git(frozen.taskPath, ['rev-parse', 'HEAD^{tree}'])).trim())
    }).pipe(Effect.provide(layer()))
  )
}, 20_000)

it('abandons only the isolated conflict and permits a new stable operation for the frozen source', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { workspace, task, applications, sync, git } = yield* setup
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/note.md'), 'task retry\n'))
      const source = yield* applications.save({ id: 'abort-task-save', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/note.md'] })
      yield* Effect.promise(() => writeFile(join(workspace.workspace, 'wiki/note.md'), 'main retry\n'))
      const main = yield* applications.save({ id: 'abort-main-save', taskId: null, expectedParent: task.baselineCommit, paths: ['wiki/note.md'] })
      const conflict = yield* sync.prepare({ id: 'abort-conflict-sync', taskId: 'task', expectedSourceHead: source.commit })
      expect(conflict.state).toBe('conflict')

      const aborted = yield* sync.abort(conflict.id)
      expect(aborted.state).toBe('aborted')
      expect(yield* sync.abort(conflict.id)).toEqual(aborted)
      expect(yield* sync.pending).toEqual([])
      expect((yield* git(workspace.workspace, ['rev-parse', 'HEAD'])).trim()).toBe(main.commit)
      expect((yield* git(task.path, ['rev-parse', 'HEAD'])).trim()).toBe(source.commit)

      const retried = yield* sync.prepare({ id: 'abort-conflict-retry', taskId: 'task', expectedSourceHead: source.commit })
      expect(retried).toMatchObject({ state: 'conflict', mainBase: main.commit, sourceHead: source.commit })
    }).pipe(Effect.provide(layer()))
  )
}, 15_000)

it('recovers the same staged resolution when its canonical SQLite receipt initially fails', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { workspace, task, applications, sync, git } = yield* setup
      const sql = yield* SqlClient.SqlClient
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/note.md'), 'task receipt\n'))
      const source = yield* applications.save({ id: 'receipt-task-save', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/note.md'] })
      yield* Effect.promise(() => writeFile(join(workspace.workspace, 'wiki/note.md'), 'main receipt\n'))
      yield* applications.save({ id: 'receipt-main-save', taskId: null, expectedParent: task.baselineCommit, paths: ['wiki/note.md'] })
      const conflict = yield* sync.prepare({ id: 'receipt-conflict-sync', taskId: 'task', expectedSourceHead: source.commit })
      const coordinator = join(root, 'sync-worktrees', conflict.id)
      yield* Effect.promise(() => writeFile(join(coordinator, 'wiki/note.md'), 'main receipt\ntask receipt\n'))
      yield* git(coordinator, ['add', '--', 'wiki/note.md'])

      yield* sql`CREATE TRIGGER fail_resolution_receipt BEFORE UPDATE OF canonical_commits ON git_sync_operations
        WHEN OLD.id='receipt-conflict-sync' AND OLD.state='conflict' BEGIN SELECT RAISE(ABORT, 'fixture'); END`
      expect(yield* sync.resolve(conflict.id).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
      expect(yield* sync.get(conflict.id)).toMatchObject({ state: 'conflict', canonicalCommits: [], conflictIndex: 0 })
      expect(yield* Effect.promise(() => readFile(join(coordinator, 'wiki/note.md'), 'utf8'))).toBe('main receipt\ntask receipt\n')

      yield* sql`DROP TRIGGER fail_resolution_receipt`
      const resolved = yield* sync.resolve(conflict.id)
      expect(resolved).toMatchObject({ state: 'aligned', conflictIndex: null })
      expect(resolved.canonicalCommits).toHaveLength(1)
      expect(yield* git(workspace.workspace, ['show', 'HEAD:wiki/note.md'])).toBe('main receipt\ntask receipt\n')
    }).pipe(Effect.provide(layer()))
  )
}, 15_000)

it('resumes accepted resolution after restart when the prepared receipt initially fails', async () => {
  const pending = await Effect.runPromise(
    Effect.gen(function* () {
      const { workspace, task, applications, sync, git } = yield* setup
      const sql = yield* SqlClient.SqlClient
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/note.md'), 'task prepared receipt\n'))
      const source = yield* applications.save({ id: 'prepared-receipt-task', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/note.md'] })
      yield* Effect.promise(() => writeFile(join(workspace.workspace, 'wiki/note.md'), 'main prepared receipt\n'))
      yield* applications.save({ id: 'prepared-receipt-main', taskId: null, expectedParent: task.baselineCommit, paths: ['wiki/note.md'] })
      const conflict = yield* sync.prepare({ id: 'prepared-receipt-sync', taskId: 'task', expectedSourceHead: source.commit })
      const coordinator = join(root, 'sync-worktrees', conflict.id)
      yield* Effect.promise(() => writeFile(join(coordinator, 'wiki/note.md'), 'main prepared receipt\ntask prepared receipt\n'))
      yield* git(coordinator, ['add', '--', 'wiki/note.md'])
      yield* sql`CREATE TRIGGER fail_resolved_prepared_receipt BEFORE UPDATE OF state ON git_sync_operations
        WHEN OLD.id='prepared-receipt-sync' AND NEW.state='prepared' BEGIN SELECT RAISE(ABORT, 'fixture'); END`
      expect(yield* sync.resolve(conflict.id).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
      const operation = yield* sync.get(conflict.id)
      expect(operation).toMatchObject({ state: 'resolving', conflictIndex: 0 })
      expect(operation.canonicalCommits).toHaveLength(1)
      yield* sql`DROP TRIGGER fail_resolved_prepared_receipt`
      return { id: conflict.id, mainPath: workspace.workspace, taskPath: task.path }
    }).pipe(Effect.provide(layer()))
  )

  await Effect.runPromise(
    Effect.gen(function* () {
      const sync = yield* TaskGitSynchronization
      const git = yield* makeVaultGit
      const resolved = yield* sync.resolve(pending.id)
      expect(resolved).toMatchObject({ state: 'aligned', conflictIndex: null })
      expect(yield* git(pending.mainPath, ['show', 'HEAD:wiki/note.md'])).toBe('main prepared receipt\ntask prepared receipt\n')
      expect((yield* git(pending.mainPath, ['rev-parse', 'HEAD^{tree}'])).trim()).toBe((yield* git(pending.taskPath, ['rev-parse', 'HEAD^{tree}'])).trim())
    }).pipe(Effect.provide(layer()))
  )
}, 20_000)

it('replays a staged conflict resolution when main advances on an unrelated file', async () => {
  const frozen = await Effect.runPromise(
    Effect.gen(function* () {
      const { workspace, task, applications, sync, git } = yield* setup
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/note.md'), 'task version\n'))
      const source = yield* applications.save({ id: 'replay-task-save', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/note.md'] })
      yield* Effect.promise(() => writeFile(join(workspace.workspace, 'wiki/note.md'), 'main version\n'))
      const main = yield* applications.save({ id: 'replay-main-save', taskId: null, expectedParent: task.baselineCommit, paths: ['wiki/note.md'] })
      const conflict = yield* sync.prepare({ id: 'replay-conflict', taskId: 'task', expectedSourceHead: source.commit })
      const coordinator = join(root, 'sync-worktrees', conflict.id)
      yield* Effect.promise(() => writeFile(join(coordinator, 'wiki/note.md'), 'main version\ntask version\n'))
      yield* git(coordinator, ['add', '--', 'wiki/note.md'])

      // The resolver has staged a valid answer, but main moves before it can be accepted.
      yield* Effect.promise(() => writeFile(join(workspace.workspace, 'wiki/other.md'), 'unrelated main change\n'))
      yield* applications.save({ id: 'replay-main-advance', taskId: null, expectedParent: main.commit, paths: ['wiki/other.md'] })
      // The failed acceptance is the durable capture boundary. A new service instance must be
      // able to recover without reading the old coordinator as its source of truth.
      expect(yield* sync.resolve(conflict.id).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      return { conflictId: conflict.id, workspace: workspace.workspace, task: task.path }
    }).pipe(Effect.provide(layer()))
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const sync = yield* TaskGitSynchronization
      const git = yield* makeVaultGit
      const rebased = yield* sync.reprepare({ id: 'replay-reprepared', taskId: 'task', supersededId: frozen.conflictId })
      expect(rebased.state).toBe('aligned')
      expect((yield* sync.get(frozen.conflictId)).state).toBe('superseded')
      expect(yield* Effect.promise(() => readFile(join(frozen.workspace, 'wiki/note.md'), 'utf8'))).toBe('main version\ntask version\n')
      expect(yield* Effect.promise(() => readFile(join(frozen.workspace, 'wiki/other.md'), 'utf8'))).toBe('unrelated main change\n')
      expect((yield* git(frozen.task, ['rev-parse', 'HEAD^{tree}'])).trim()).toBe((yield* git(frozen.workspace, ['rev-parse', 'HEAD^{tree}'])).trim())
    }).pipe(Effect.provide(layer()))
  )
}, 20_000)

it('re-enters a conflict when a newer main edit overlaps a staged resolution replay', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { workspace, task, applications, sync, git } = yield* setup
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/note.md'), 'task version\n'))
      const source = yield* applications.save({ id: 'overlap-task-save', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/note.md'] })
      yield* Effect.promise(() => writeFile(join(workspace.workspace, 'wiki/note.md'), 'main version\n'))
      const main = yield* applications.save({ id: 'overlap-main-save', taskId: null, expectedParent: task.baselineCommit, paths: ['wiki/note.md'] })
      const conflict = yield* sync.prepare({ id: 'overlap-conflict', taskId: 'task', expectedSourceHead: source.commit })
      const coordinator = join(root, 'sync-worktrees', conflict.id)
      yield* Effect.promise(() => writeFile(join(coordinator, 'wiki/note.md'), 'main version\ntask version\n'))
      yield* git(coordinator, ['add', '--', 'wiki/note.md'])
      yield* Effect.promise(() => writeFile(join(workspace.workspace, 'wiki/note.md'), 'newer main version\n'))
      yield* applications.save({ id: 'overlap-main-advance', taskId: null, expectedParent: main.commit, paths: ['wiki/note.md'] })

      const rebased = yield* sync.reprepare({ id: 'overlap-reprepared', taskId: 'task', supersededId: conflict.id })
      expect(rebased.state).toBe('conflict')
      expect((yield* sync.get(conflict.id)).state).toBe('superseded')
      const replacementCoordinator = join(root, 'sync-worktrees', rebased.id)
      yield* Effect.promise(() => writeFile(join(replacementCoordinator, 'wiki/note.md'), 'newer main version\nuser merged task version\n'))
      yield* git(replacementCoordinator, ['add', '--', 'wiki/note.md'])
      const resolved = yield* sync.resolve(rebased.id)
      expect(resolved.state).toBe('aligned')
      expect(yield* Effect.promise(() => readFile(join(workspace.workspace, 'wiki/note.md'), 'utf8'))).toBe('newer main version\nuser merged task version\n')
      expect((yield* git(task.path, ['rev-parse', 'HEAD^{tree}'])).trim()).toBe((yield* git(workspace.workspace, ['rev-parse', 'HEAD^{tree}'])).trim())
    }).pipe(Effect.provide(layer()))
  )
}, 20_000)

it('replays an earlier accepted prefix before a later conflict after main advances', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { workspace, task, applications, sync, git } = yield* setup
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/first.md'), 'task first\n'))
      const first = yield* applications.save({ id: 'prefix-replay-first', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/first.md'] })
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/second.md'), 'task second\n'))
      const second = yield* applications.save({ id: 'prefix-replay-second', taskId: 'task', expectedParent: first.commit, paths: ['wiki/second.md'] })
      yield* Effect.promise(async () => {
        await writeFile(join(workspace.workspace, 'wiki/first.md'), 'main first\n')
        await writeFile(join(workspace.workspace, 'wiki/second.md'), 'main second\n')
      })
      const main = yield* applications.save({ id: 'prefix-replay-main', taskId: null, expectedParent: task.baselineCommit, paths: ['wiki/first.md', 'wiki/second.md'] })
      const conflict = yield* sync.prepare({ id: 'prefix-replay-operation', taskId: 'task', expectedSourceHead: second.commit })
      const coordinator = join(root, 'sync-worktrees', conflict.id)
      yield* Effect.promise(() => writeFile(join(coordinator, 'wiki/first.md'), 'main first\ntask first\n'))
      yield* git(coordinator, ['add', '--', 'wiki/first.md'])
      const secondConflict = yield* sync.resolve(conflict.id)
      expect(secondConflict).toMatchObject({ state: 'conflict', conflictIndex: 1, canonicalCommits: [{ sourceChangeId: first.id }] })
      yield* Effect.promise(() => writeFile(join(coordinator, 'wiki/second.md'), 'main second\ntask second\n'))
      yield* git(coordinator, ['add', '--', 'wiki/second.md'])
      yield* Effect.promise(() => writeFile(join(workspace.workspace, 'wiki/unrelated.md'), 'main moved\n'))
      yield* applications.save({ id: 'prefix-replay-main-advance', taskId: null, expectedParent: main.commit, paths: ['wiki/unrelated.md'] })
      expect(yield* sync.resolve(conflict.id).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })

      const replacement = yield* sync.reprepare({ id: 'prefix-replay-replacement', taskId: 'task', supersededId: conflict.id })
      expect(replacement.state).toBe('aligned')
      expect(yield* Effect.promise(() => readFile(join(workspace.workspace, 'wiki/first.md'), 'utf8'))).toBe('main first\ntask first\n')
      expect(yield* Effect.promise(() => readFile(join(workspace.workspace, 'wiki/second.md'), 'utf8'))).toBe('main second\ntask second\n')
      expect(yield* Effect.promise(() => readFile(join(workspace.workspace, 'wiki/unrelated.md'), 'utf8'))).toBe('main moved\n')
    }).pipe(Effect.provide(layer()))
  )
}, 25_000)

it('resolves multiple source conflicts in order without replacing the operation identity', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { workspace, task, applications, sync, git } = yield* setup
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/first.md'), 'task first\n'))
      const first = yield* applications.save({ id: 'multi-first-task', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/first.md'] })
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/second.md'), 'task second\n'))
      const second = yield* applications.save({ id: 'multi-second-task', taskId: 'task', expectedParent: first.commit, paths: ['wiki/second.md'] })
      yield* Effect.promise(async () => {
        await writeFile(join(workspace.workspace, 'wiki/first.md'), 'main first\n')
        await writeFile(join(workspace.workspace, 'wiki/second.md'), 'main second\n')
      })
      yield* applications.save({ id: 'multi-main', taskId: null, expectedParent: task.baselineCommit, paths: ['wiki/first.md', 'wiki/second.md'] })
      const operation = yield* sync.prepare({ id: 'multi-conflict-sync', taskId: 'task', expectedSourceHead: second.commit })
      expect(operation).toMatchObject({ state: 'conflict', conflictIndex: 0, canonicalCommits: [] })
      const coordinator = join(root, 'sync-worktrees', operation.id)

      yield* Effect.promise(() => writeFile(join(coordinator, 'wiki/first.md'), 'main first\ntask first\n'))
      yield* git(coordinator, ['add', '--', 'wiki/first.md'])
      const nextConflict = yield* sync.resolve(operation.id)
      expect(nextConflict).toMatchObject({ id: operation.id, state: 'conflict', conflictIndex: 1 })
      expect(nextConflict.canonicalCommits.map((item) => item.sourceChangeId)).toEqual(['multi-first-task'])

      yield* Effect.promise(() => writeFile(join(coordinator, 'wiki/second.md'), 'main second\ntask second\n'))
      yield* git(coordinator, ['add', '--', 'wiki/second.md'])
      const resolved = yield* sync.resolve(operation.id)
      expect(resolved).toMatchObject({ id: operation.id, state: 'aligned', conflictIndex: null })
      expect(resolved.canonicalCommits.map((item) => item.sourceChangeId)).toEqual(['multi-first-task', 'multi-second-task'])
      expect(yield* git(workspace.workspace, ['show', 'HEAD:wiki/first.md'])).toBe('main first\ntask first\n')
      expect(yield* git(workspace.workspace, ['show', 'HEAD:wiki/second.md'])).toBe('main second\ntask second\n')
      expect((yield* git(workspace.workspace, ['rev-parse', 'HEAD^{tree}'])).trim()).toBe((yield* git(task.path, ['rev-parse', 'HEAD^{tree}'])).trim())
    }).pipe(Effect.provide(layer()))
  )
}, 20_000)

it('rejects unstaged or non-wiki coordinator edits without discarding the resolution draft', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { workspace, task, applications, sync, git } = yield* setup
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/note.md'), 'task guarded\n'))
      const source = yield* applications.save({ id: 'guarded-task', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/note.md'] })
      yield* Effect.promise(() => writeFile(join(workspace.workspace, 'wiki/note.md'), 'main guarded\n'))
      yield* applications.save({ id: 'guarded-main', taskId: null, expectedParent: task.baselineCommit, paths: ['wiki/note.md'] })
      const conflict = yield* sync.prepare({ id: 'guarded-conflict', taskId: 'task', expectedSourceHead: source.commit })
      const coordinator = join(root, 'sync-worktrees', conflict.id)
      const resolution = 'main guarded\ntask guarded\n'
      yield* Effect.promise(() => writeFile(join(coordinator, 'wiki/note.md'), resolution))
      expect(yield* sync.resolve(conflict.id).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      expect(yield* Effect.promise(() => readFile(join(coordinator, 'wiki/note.md'), 'utf8'))).toBe(resolution)

      yield* git(coordinator, ['add', '--', 'wiki/note.md'])
      yield* Effect.promise(() => writeFile(join(coordinator, 'AGENTS.md'), 'not part of wiki conflict\n'))
      yield* git(coordinator, ['add', '--', 'AGENTS.md'])
      expect(yield* sync.resolve(conflict.id).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      expect(yield* Effect.promise(() => readFile(join(coordinator, 'wiki/note.md'), 'utf8'))).toBe(resolution)

      yield* git(coordinator, ['restore', '--staged', '--worktree', '--', 'AGENTS.md'])
      expect(yield* sync.resolve(conflict.id)).toMatchObject({ state: 'aligned' })
    }).pipe(Effect.provide(layer()))
  )
}, 15_000)

it('finishes an explicit abort after coordinator removal when its SQLite receipt initially fails', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { workspace, task, applications, sync } = yield* setup
      const sql = yield* SqlClient.SqlClient
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/note.md'), 'task abort receipt\n'))
      const source = yield* applications.save({ id: 'abort-receipt-task', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/note.md'] })
      yield* Effect.promise(() => writeFile(join(workspace.workspace, 'wiki/note.md'), 'main abort receipt\n'))
      yield* applications.save({ id: 'abort-receipt-main', taskId: null, expectedParent: task.baselineCommit, paths: ['wiki/note.md'] })
      const conflict = yield* sync.prepare({ id: 'abort-receipt-sync', taskId: 'task', expectedSourceHead: source.commit })
      yield* sql`CREATE TRIGGER fail_abort_receipt BEFORE UPDATE OF state ON git_sync_operations
        WHEN OLD.id='abort-receipt-sync' AND NEW.state='aborted' BEGIN SELECT RAISE(ABORT, 'fixture'); END`
      expect(yield* sync.abort(conflict.id).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
      expect(yield* sync.get(conflict.id)).toMatchObject({ state: 'conflict' })
      expect(yield* Effect.promise(() => readFile(join(root, 'sync-worktrees', conflict.id, 'wiki/note.md')).then(() => 'exists', (error: NodeJS.ErrnoException) => error.code))).toBe('ENOENT')

      yield* sql`DROP TRIGGER fail_abort_receipt`
      expect(yield* sync.abort(conflict.id)).toMatchObject({ state: 'aborted' })
      expect(yield* sync.pending).toEqual([])
    }).pipe(Effect.provide(layer()))
  )
}, 15_000)

it('restarts preparation from its retained prefix after a later canonical append receipt fails', async () => {
  const pending = await Effect.runPromise(
    Effect.gen(function* () {
      const { task, applications, sync } = yield* setup
      const sql = yield* SqlClient.SqlClient
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/first.md'), 'retained first\n'))
      const first = yield* applications.save({ id: 'append-first-save', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/first.md'] })
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/second.md'), 'retained second\n'))
      const second = yield* applications.save({ id: 'append-second-save', taskId: 'task', expectedParent: first.commit, paths: ['wiki/second.md'] })
      yield* sql`CREATE TRIGGER fail_second_canonical_append BEFORE UPDATE OF canonical_commits ON git_sync_operations
        WHEN OLD.id='append-prefix-sync' AND json_array_length(NEW.canonical_commits)=2 BEGIN SELECT RAISE(ABORT, 'fixture'); END`
      expect(yield* sync.prepare({ id: 'append-prefix-sync', taskId: 'task', expectedSourceHead: second.commit }).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
      const operation = yield* sync.get('append-prefix-sync')
      expect(operation).toMatchObject({ state: 'preparing', preparedHead: null })
      expect(operation.canonicalCommits.map((item) => item.sourceChangeId)).toEqual(['append-first-save'])
      yield* sql`DROP TRIGGER fail_second_canonical_append`
      return { sourceHead: second.commit, taskPath: task.path }
    }).pipe(Effect.provide(layer()))
  )

  await Effect.runPromise(
    Effect.gen(function* () {
      const sync = yield* TaskGitSynchronization
      const git = yield* makeVaultGit
      const prepared = yield* sync.prepare({ id: 'append-prefix-sync', taskId: 'task', expectedSourceHead: pending.sourceHead })
      expect(prepared.canonicalCommits.map((item) => item.sourceChangeId)).toEqual(['append-first-save', 'append-second-save'])
      yield* sync.publish(prepared.id)
      const aligned = yield* sync.align(prepared.id)
      expect(aligned.state).toBe('aligned')
      expect(yield* git(join(root, 'workspace'), ['show', 'HEAD:wiki/first.md'])).toBe('retained first\n')
      expect(yield* git(join(root, 'workspace'), ['show', 'HEAD:wiki/second.md'])).toBe('retained second\n')
      expect((yield* git(join(root, 'workspace'), ['rev-parse', 'HEAD^{tree}'])).trim()).toBe((yield* git(pending.taskPath, ['rev-parse', 'HEAD^{tree}'])).trim())
    }).pipe(Effect.provide(layer()))
  )
}, 20_000)

it('refuses dirty or advanced main after preparation without changing its files', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { workspace, task, applications, sync, git } = yield* setup
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/task.md'), 'task edit\n'))
      const source = yield* applications.save({ id: 'task-change', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/task.md'] })
      const prepared = yield* sync.prepare({ id: 'stale-sync', taskId: 'task', expectedSourceHead: source.commit })
      expect(prepared.state).toBe('prepared')
      yield* Effect.promise(() => writeFile(join(workspace.workspace, 'wiki/draft.md'), 'unsaved main draft\n'))
      expect(yield* sync.publish(prepared.id).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      expect(yield* Effect.promise(() => readFile(join(workspace.workspace, 'wiki/draft.md'), 'utf8'))).toBe('unsaved main draft\n')
      const main = yield* applications.save({ id: 'main-save', taskId: null, expectedParent: prepared.mainBase, paths: ['wiki/draft.md'] })
      expect(yield* sync.publish(prepared.id).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      expect((yield* git(workspace.workspace, ['rev-parse', 'HEAD'])).trim()).toBe(main.commit)
      expect(yield* Effect.promise(() => readFile(join(workspace.workspace, 'wiki/draft.md'), 'utf8'))).toBe('unsaved main draft\n')
    }).pipe(Effect.provide(layer()))
  )
}, 15_000)

it('refuses publication when the workspace no longer has main checked out', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { workspace, task, applications, sync, git } = yield* setup
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/detached.md'), 'prepared while main was checked out\n'))
      const source = yield* applications.save({ id: 'detached-save', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/detached.md'] })
      const prepared = yield* sync.prepare({ id: 'detached-sync', taskId: 'task', expectedSourceHead: source.commit })
      yield* git(workspace.workspace, ['switch', '--detach', prepared.mainBase])
      expect(yield* sync.publish(prepared.id).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      expect((yield* git(workspace.workspace, ['rev-parse', 'refs/heads/main'])).trim()).toBe(prepared.mainBase)
      expect((yield* git(workspace.workspace, ['rev-parse', 'HEAD'])).trim()).toBe(prepared.mainBase)
      expect(yield* sync.get(prepared.id)).toMatchObject({ state: 'prepared', publishedHead: null })
    }).pipe(Effect.provide(layer()))
  )
}, 15_000)

it('publishes selected commits while a Task draft waits, then a later round aligns all publications', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { workspace, task, applications, sync, git } = yield* setup
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/selected.md'), 'selected\n'))
      const firstSource = yield* applications.save({ id: 'selected-save', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/selected.md'] })
      const prepared = yield* sync.prepare({ id: 'selected-sync', taskId: 'task', expectedSourceHead: firstSource.commit })
      yield* sync.publish(prepared.id)
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/draft.md'), 'later draft\n'))
      expect(yield* sync.align(prepared.id).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      expect(yield* Effect.promise(() => readFile(join(task.path, 'wiki/draft.md'), 'utf8'))).toBe('later draft\n')
      expect(yield* Effect.promise(() => readFile(join(workspace.workspace, 'wiki/selected.md'), 'utf8'))).toBe('selected\n')
      const secondSource = yield* applications.save({ id: 'draft-save', taskId: 'task', expectedParent: firstSource.commit, paths: ['wiki/draft.md'] })
      const second = yield* sync.synchronize({ id: 'draft-sync', taskId: 'task', expectedSourceHead: secondSource.commit })
      expect(second.state).toBe('aligned')
      expect((yield* sync.get(prepared.id)).state).toBe('aligned')
      expect((yield* git(task.path, ['rev-parse', 'HEAD^{tree}'])).trim()).toBe((yield* git(workspace.workspace, ['rev-parse', 'HEAD^{tree}'])).trim())
    }).pipe(Effect.provide(layer()))
  )
}, 20_000)

it('does not align an older publication past a newer prepared operation for the same Task', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { workspace, task, applications, sync, git } = yield* setup
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/first-round.md'), 'first round\n'))
      const firstSource = yield* applications.save({ id: 'ordered-save-1', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/first-round.md'] })
      const first = yield* sync.prepare({ id: 'ordered-sync-1', taskId: 'task', expectedSourceHead: firstSource.commit })
      yield* sync.publish(first.id)

      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/second-round.md'), 'second round\n'))
      const secondSource = yield* applications.save({ id: 'ordered-save-2', taskId: 'task', expectedParent: firstSource.commit, paths: ['wiki/second-round.md'] })
      const second = yield* sync.prepare({ id: 'ordered-sync-2', taskId: 'task', expectedSourceHead: secondSource.commit })
      expect(second).toMatchObject({ state: 'prepared', sourceFrontier: firstSource.commit, sourceHead: secondSource.commit })

      const beforeOldAlignment = (yield* git(task.path, ['rev-parse', 'HEAD'])).trim()
      expect(yield* sync.align(first.id)).toMatchObject({ state: 'published', alignedHead: null })
      expect((yield* git(task.path, ['rev-parse', 'HEAD'])).trim()).toBe(beforeOldAlignment)
      expect(yield* sync.get(second.id)).toMatchObject({ state: 'prepared' })

      yield* sync.publish(second.id)
      const aligned = yield* sync.align(second.id)
      expect(aligned).toMatchObject({ state: 'aligned', sourceHead: secondSource.commit })
      expect(yield* sync.get(first.id)).toMatchObject({ state: 'aligned' })
      expect((yield* git(task.path, ['rev-parse', 'HEAD^{tree}'])).trim()).toBe((yield* git(workspace.workspace, ['rev-parse', 'HEAD^{tree}'])).trim())
    }).pipe(Effect.provide(layer()))
  )
}, 20_000)

it('aligns a Task to a newer registered main even when it has no source changes', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { workspace, task, applications, sync, git } = yield* setup
      const sql = yield* SqlClient.SqlClient
      yield* Effect.promise(() => writeFile(join(workspace.workspace, 'wiki/user.md'), 'main-only edit\n'))
      const mainSource = yield* applications.save({ id: 'main-only', taskId: null, expectedParent: task.baselineCommit, paths: ['wiki/user.md'] })
      const result = yield* sync.synchronize({ id: 'main-to-task', taskId: 'task', expectedSourceHead: task.baselineCommit })
      expect(result).toMatchObject({ state: 'aligned', sourceChanges: [], sourceCommits: [], preparedHead: mainSource.commit, publishedHead: mainSource.commit })
      expect(yield* Effect.promise(() => readFile(join(task.path, 'wiki/user.md'), 'utf8'))).toBe('main-only edit\n')
      expect((yield* git(task.path, ['rev-parse', 'HEAD^{tree}'])).trim()).toBe((yield* git(workspace.workspace, ['rev-parse', 'HEAD^{tree}'])).trim())
      expect(yield* sql`UPDATE git_sync_operations SET canonical_commits='[{"tampered":true}]' WHERE id='main-to-task'`.pipe(Effect.flip)).toMatchObject({
        _tag: 'SqlError'
      })
      expect(yield* sync.get(result.id)).toMatchObject({ canonicalCommits: [] })
    }).pipe(Effect.provide(layer()))
  )
}, 15_000)

it('recovers publication and alignment after Git succeeds but their database receipts fail', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { workspace, task, applications, sync, git } = yield* setup
      const sql = yield* SqlClient.SqlClient
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/recovery.md'), 'recover me\n'))
      const source = yield* applications.save({ id: 'recovery-save', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/recovery.md'] })
      yield* Effect.promise(() => writeFile(join(workspace.workspace, 'wiki/main.md'), 'concurrent main\n'))
      yield* applications.save({ id: 'recovery-main', taskId: null, expectedParent: task.baselineCommit, paths: ['wiki/main.md'] })
      const prepared = yield* sync.prepare({ id: 'recovery-sync', taskId: 'task', expectedSourceHead: source.commit })
      yield* sql`CREATE TRIGGER fail_publish BEFORE UPDATE OF state ON git_sync_operations
      WHEN NEW.state='published' BEGIN SELECT RAISE(ABORT, 'lost publish receipt'); END`
      expect(yield* sync.publish(prepared.id).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
      expect((yield* git(workspace.workspace, ['rev-parse', 'HEAD'])).trim()).toBe(prepared.preparedHead)
      yield* sql`DROP TRIGGER fail_publish`
      expect((yield* sync.publish(prepared.id)).state).toBe('published')
      yield* sql`CREATE TRIGGER fail_align BEFORE UPDATE OF state ON git_sync_operations
      WHEN NEW.state='aligned' BEGIN SELECT RAISE(ABORT, 'lost align receipt'); END`
      expect(yield* sync.align(prepared.id).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
      const moved = (yield* git(task.path, ['rev-parse', 'HEAD'])).trim()
      expect(moved).not.toBe(source.commit)
      yield* sql`DROP TRIGGER fail_align`
      const recovered = yield* sync.align(prepared.id)
      expect(recovered).toMatchObject({ state: 'aligned', alignedHead: moved })
      expect((yield* git(task.path, ['rev-parse', 'HEAD^{tree}'])).trim()).toBe((yield* git(workspace.workspace, ['rev-parse', 'HEAD^{tree}'])).trim())
    }).pipe(Effect.provide(layer()))
  )
}, 20_000)

it('refuses alignment recovery when its protected ref no longer matches the durable checkpoint', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { workspace, task, applications, sync, git } = yield* setup
      const sql = yield* SqlClient.SqlClient
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/alignment-ref.md'), 'Task edit\n'))
      const source = yield* applications.save({ id: 'alignment-ref-save', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/alignment-ref.md'] })
      yield* Effect.promise(() => writeFile(join(workspace.workspace, 'wiki/main-concurrent.md'), 'main edit\n'))
      yield* applications.save({ id: 'alignment-ref-main', taskId: null, expectedParent: task.baselineCommit, paths: ['wiki/main-concurrent.md'] })
      const prepared = yield* sync.prepare({ id: 'alignment-ref-sync', taskId: 'task', expectedSourceHead: source.commit })
      yield* sync.publish(prepared.id)
      yield* sql`CREATE TRIGGER fail_alignment_ref_receipt BEFORE UPDATE OF state ON git_sync_operations
      WHEN NEW.state='aligned' BEGIN SELECT RAISE(ABORT, 'lost align receipt'); END`
      expect(yield* sync.align(prepared.id).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
      const aligning = yield* sync.get(prepared.id)
      expect(aligning).toMatchObject({ state: 'aligning' })
      expect(aligning.alignmentCommit).not.toBeNull()
      yield* sql`DROP TRIGGER fail_alignment_ref_receipt`
      yield* git(workspace.workspace, ['update-ref', `refs/folio/sync/${prepared.id}/alignment`, task.baselineCommit])
      expect(yield* sync.align(prepared.id).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      expect(yield* sync.get(prepared.id)).toMatchObject({ state: 'aligning', alignedHead: null, alignmentCommit: aligning.alignmentCommit })
    }).pipe(Effect.provide(layer()))
  )
}, 20_000)

it('discovers a published operation after reopening and aligns once the manual draft is gone', async () => {
  const saved = await Effect.runPromise(
    Effect.gen(function* () {
      const { task, applications, sync } = yield* setup
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/saved.md'), 'saved before restart\n'))
      const source = yield* applications.save({ id: 'restart-save', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/saved.md'] })
      const prepared = yield* sync.prepare({ id: 'restart-sync', taskId: 'task', expectedSourceHead: source.commit })
      yield* sync.publish(prepared.id)
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/manual-draft.md'), 'hold alignment\n'))
      expect(yield* sync.align(prepared.id).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      return { task, source }
    }).pipe(Effect.provide(layer()))
  )
  await rm(join(saved.task.path, 'wiki/manual-draft.md'))
  await Effect.runPromise(
    Effect.gen(function* () {
      const sync = yield* TaskGitSynchronization
      const git = yield* makeVaultGit
      expect(yield* sync.pending).toMatchObject([{ id: 'restart-sync', state: 'published' }])
      const aligned = yield* sync.align('restart-sync')
      expect(aligned).toMatchObject({ state: 'aligned', sourceHead: saved.source.commit })
      expect((yield* git(saved.task.path, ['status', '--porcelain'])).trim()).toBe('')
      expect(yield* sync.pending).toEqual([])
    }).pipe(Effect.provide(layer()))
  )
}, 20_000)

it('recreates the exact prepared commit from its database checkpoint after a lost preparation receipt', async () => {
  const expected = await Effect.runPromise(
    Effect.gen(function* () {
      const { task, applications, sync, git, workspace } = yield* setup
      const sql = yield* SqlClient.SqlClient
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/checkpoint.md'), 'checkpointed\n'))
      const source = yield* applications.save({ id: 'checkpoint-save', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/checkpoint.md'] })
      yield* sql`CREATE TRIGGER fail_prepare_receipt BEFORE UPDATE OF state ON git_sync_operations
      WHEN NEW.state='prepared' BEGIN SELECT RAISE(ABORT, 'lost prepare receipt'); END`
      expect(yield* sync.prepare({ id: 'checkpoint-sync', taskId: 'task', expectedSourceHead: source.commit }).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
      const rows = yield* sql<{ preparedHead: string; state: string }>`SELECT prepared_head AS preparedHead, state
      FROM git_sync_operations WHERE id='checkpoint-sync'`
      expect(rows[0]).toMatchObject({ state: 'preparing' })
      expect((yield* git(workspace.workspace, ['for-each-ref', '--format=%(objectname)', 'refs/folio/sync/checkpoint-sync/canonical'])).trim()).toBe(rows[0]!.preparedHead)
      yield* sql`DROP TRIGGER fail_prepare_receipt`
      return { source, preparedHead: rows[0]!.preparedHead }
    }).pipe(Effect.provide(layer()))
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const sync = yield* TaskGitSynchronization
      const git = yield* makeVaultGit
      const recovered = yield* sync.prepare({ id: 'checkpoint-sync', taskId: 'task', expectedSourceHead: expected.source.commit })
      expect(recovered).toMatchObject({ state: 'prepared', preparedHead: expected.preparedHead })
      expect(yield* git(join(root, 'workspace'), ['worktree', 'list', '--porcelain'])).not.toContain(join(root, 'sync-worktrees/checkpoint-sync'))
    }).pipe(Effect.provide(layer()))
  )
}, 20_000)

it('refuses to remove a coordinator path whose owned worktree identity was replaced', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { workspace, task, applications, sync } = yield* setup
      const sql = yield* SqlClient.SqlClient
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/replaced.md'), 'checkpointed\n'))
      const source = yield* applications.save({ id: 'replaced-save', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/replaced.md'] })
      yield* sql`CREATE TRIGGER fail_replaced_prepare_receipt BEFORE UPDATE OF state ON git_sync_operations
      WHEN NEW.state='prepared' BEGIN SELECT RAISE(ABORT, 'lost prepare receipt'); END`
      expect(yield* sync.prepare({ id: 'replaced-coordinator-sync', taskId: 'task', expectedSourceHead: source.commit }).pipe(Effect.flip)).toMatchObject({
        reason: 'storage'
      })
      yield* sql`DROP TRIGGER fail_replaced_prepare_receipt`

      const coordinator = join(root, 'sync-worktrees/replaced-coordinator-sync')
      const sentinel = join(coordinator, 'external.txt')
      yield* Effect.promise(async () => {
        await rm(coordinator, { recursive: true, force: true })
        await mkdir(coordinator)
        await writeFile(sentinel, 'must survive\n')
      })

      expect(yield* sync.prepare({ id: 'replaced-coordinator-sync', taskId: 'task', expectedSourceHead: source.commit }).pipe(Effect.flip)).toMatchObject({
        reason: 'invalid-state'
      })
      expect(yield* Effect.promise(() => readFile(sentinel, 'utf8'))).toBe('must survive\n')
      expect(yield* sync.get('replaced-coordinator-sync')).toMatchObject({ state: 'preparing' })

      yield* sql`UPDATE git_sync_operations SET state='prepared' WHERE id='replaced-coordinator-sync'`
      expect(yield* sync.prepare({ id: 'replaced-coordinator-sync', taskId: 'task', expectedSourceHead: source.commit }).pipe(Effect.flip)).toMatchObject({
        reason: 'invalid-state'
      })
      expect(yield* Effect.promise(() => readFile(sentinel, 'utf8'))).toBe('must survive\n')
      expect((yield* sql<{ state: string }>`SELECT state FROM git_sync_operations WHERE id='replaced-coordinator-sync'`)[0]?.state).toBe('prepared')
      expect(yield* Effect.promise(() => readFile(join(workspace.workspace, 'wiki/replaced.md'), 'utf8').then(() => 'exists', () => 'missing'))).toBe('missing')
    }).pipe(Effect.provide(layer()))
  )
}, 20_000)

it('blocks Run admission until an unfinished synchronization is aligned', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { task, store, applications, sync } = yield* setup
      yield* store.createSession({ id: 'session', taskId: 'task', agent: 'pi', adapterVersion: 'fixture', purpose: 'task', syncOperationId: null })
      yield* store.bindSession('session', { acpSessionId: 'acp-session', nativeSessionId: null })
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/run-gate.md'), 'saved before next run\n'))
      const source = yield* applications.save({ id: 'run-gate-save', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/run-gate.md'] })
      const prepared = yield* sync.prepare({ id: 'run-gate-sync', taskId: 'task', expectedSourceHead: source.commit })
      const run = {
        id: 'blocked-run',
        taskId: 'task',
        sessionId: 'session',
        prompt: 'continue',
        purpose: 'execution' as const,
        resumesRunId: null,
        baselineCommit: source.commit
      }
      expect(yield* reserveClaimedRun(run).pipe(Effect.flip)).toMatchObject({ reason: 'task-busy' })
      yield* sync.publish(prepared.id)
      const aligned = yield* sync.align(prepared.id)
      yield* reserveClaimedRun({ ...run, id: 'admitted-run', baselineCommit: aligned.alignedHead! })
      expect(yield* store.runs('task')).toMatchObject([{ id: 'admitted-run', baselineCommit: aligned.alignedHead }])
    }).pipe(Effect.provide(layer()))
  )
}, 15_000)

it('projects one explicit wiki save and its synchronization checkpoints onto every originating Run', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { workspace, task, store, applications, sync, git } = yield* setup
      yield* store.createSession({ id: 'sync-session', taskId: 'task', agent: 'pi', adapterVersion: 'fixture', purpose: 'task', syncOperationId: null })
      yield* store.bindSession('sync-session', { acpSessionId: 'sync-acp', nativeSessionId: null })
      const finishRun = Effect.fn('fixture.finishRun')(function* (id: string, baselineCommit: string) {
        yield* reserveClaimedRun({ id, taskId: 'task', sessionId: 'sync-session', prompt: id, purpose: 'execution', resumesRunId: null, baselineCommit })
        yield* finishClaimedRun(id, 'succeeded')
      })
      const saveRunWiki = Effect.fn('fixture.saveRunWiki')(function* (id: string, runIds: readonly [string, ...string[]], parent: string, path: string, contents: string) {
        yield* Effect.promise(() => writeFile(join(task.path, path), contents))
        return yield* applications.saveRunWiki({ id, taskId: 'task', runIds, expectedParent: parent, paths: [path] })
      })

      yield* finishRun('synced-run', task.baselineCommit)
      yield* finishRun('synced-run-2', task.baselineCommit)
      expect((yield* store.runs('task')).find((run) => run.id === 'synced-run')?.syncState).toBe('pending')
      const firstSource = yield* saveRunWiki('synced-run-save', ['synced-run-2', 'synced-run', 'synced-run'], task.baselineCommit, 'wiki/run.md', 'run result\n')
      expect(yield* git(task.path, ['show', '-s', '--format=%B', firstSource.commit])).toContain(
        'Folio-Run-Id: synced-run\nFolio-Run-Id: synced-run-2\n'
      )
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/duplicate.md'), 'ambiguous attribution\n'))
      expect(yield* applications.saveRunWiki({ id: 'duplicate-run-owner', taskId: 'task', runIds: ['synced-run'], expectedParent: firstSource.commit,
        paths: ['wiki/duplicate.md'] }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      yield* Effect.promise(() => rm(join(task.path, 'wiki/duplicate.md')))
      const first = yield* sync.synchronize({ id: 'synced-run-operation', taskId: 'task', expectedSourceHead: firstSource.commit })
      expect(first.state).toBe('aligned')
      expect((yield* store.runs('task')).find((run) => run.id === 'synced-run')?.syncState).toBe('completed')
      expect((yield* store.runs('task')).find((run) => run.id === 'synced-run-2')?.syncState).toBe('completed')
      expect(yield* applications.saveRunWiki({ id: 'synced-run-save', taskId: 'task', runIds: ['synced-run-2', 'synced-run'], expectedParent: task.baselineCommit,
        paths: ['wiki/run.md'] })).toEqual(firstSource)
      expect(yield* applications.saveRunWiki({ id: 'synced-run-save', taskId: 'task', runIds: ['synced-run'], expectedParent: task.baselineCommit,
        paths: ['wiki/run.md'] }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/late.md'), 'late attribution\n'))
      expect(yield* applications.saveRunWiki({ id: 'late-run-save', taskId: 'task', runIds: ['synced-run'], expectedParent: first.alignedHead!,
        paths: ['wiki/late.md'] }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      yield* Effect.promise(() => rm(join(task.path, 'wiki/late.md')))

      yield* finishRun('conflicted-run', first.alignedHead!)
      const conflictSource = yield* saveRunWiki('conflicted-run-save', ['conflicted-run'], first.alignedHead!, 'wiki/conflict.md', 'Task result\n')
      yield* Effect.promise(() => writeFile(join(workspace.workspace, 'wiki/conflict.md'), 'main result\n'))
      yield* applications.save({ id: 'conflicted-main-save', taskId: null, expectedParent: first.publishedHead!, paths: ['wiki/conflict.md'] })
      const conflict = yield* sync.prepare({ id: 'conflicted-run-operation', taskId: 'task', expectedSourceHead: conflictSource.commit })
      expect(conflict.state).toBe('conflict')
      expect((yield* store.runs('task')).find((run) => run.id === 'conflicted-run')?.syncState).toBe('conflict')

      expect((yield* sync.abort(conflict.id)).state).toBe('aborted')
      expect((yield* store.runs('task')).find((run) => run.id === 'conflicted-run')?.syncState).toBe('failed')
      const retry = yield* sync.prepare({ id: 'conflicted-run-retry', taskId: 'task', expectedSourceHead: conflictSource.commit })
      expect(retry.state).toBe('conflict')
      expect((yield* store.runs('task')).find((run) => run.id === 'conflicted-run')?.syncState).toBe('conflict')

      const coordinator = join(root, 'sync-worktrees', retry.id)
      yield* Effect.promise(() => writeFile(join(coordinator, 'wiki/conflict.md'), 'main result\nTask result\n'))
      yield* git(coordinator, ['add', '--', 'wiki/conflict.md'])
      expect((yield* sync.resolve(retry.id)).state).toBe('aligned')
      expect((yield* store.runs('task')).find((run) => run.id === 'conflicted-run')?.syncState).toBe('completed')
    }).pipe(Effect.provide(layer()))
  )
}, 25_000)

it('refuses publication when the protected canonical ref no longer matches its checkpoint', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { workspace, task, applications, sync, git } = yield* setup
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/ref.md'), 'protected result\n'))
      const source = yield* applications.save({ id: 'ref-save', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/ref.md'] })
      const prepared = yield* sync.prepare({ id: 'ref-sync', taskId: 'task', expectedSourceHead: source.commit })
      yield* git(workspace.workspace, ['update-ref', 'refs/folio/sync/ref-sync/canonical', task.baselineCommit])
      expect(yield* sync.publish(prepared.id).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      expect((yield* git(workspace.workspace, ['rev-parse', 'HEAD'])).trim()).toBe(task.baselineCommit)
      expect(yield* sync.get(prepared.id)).toMatchObject({ state: 'prepared', publishedHead: null })
    }).pipe(Effect.provide(layer()))
  )
}, 15_000)

it('serializes publications from Tasks created at the same main baseline', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { workspace, task, worktrees, applications, sync, git } = yield* setup
      const sibling = yield* worktrees.create({ id: 'sibling', goal: 'parallel manual edit', configuration: { agent: 'pi', skillIds: [], integrationIds: [] } })
      expect(sibling.baselineCommit).toBe(task.baselineCommit)
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/first.md'), 'first Task\n'))
      yield* Effect.promise(() => writeFile(join(sibling.path, 'wiki/second.md'), 'second Task\n'))
      const firstSource = yield* applications.save({ id: 'first-task-save', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/first.md'] })
      const secondSource = yield* applications.save({ id: 'second-task-save', taskId: 'sibling', expectedParent: sibling.baselineCommit, paths: ['wiki/second.md'] })
      const first = yield* sync.synchronize({ id: 'first-task-sync', taskId: 'task', expectedSourceHead: firstSource.commit })
      const second = yield* sync.synchronize({ id: 'second-task-sync', taskId: 'sibling', expectedSourceHead: secondSource.commit })
      expect(second).toMatchObject({ state: 'aligned', sourceFrontier: sibling.baselineCommit, sourceHead: secondSource.commit })
      expect(yield* Effect.promise(() => readFile(join(workspace.workspace, 'wiki/first.md'), 'utf8'))).toBe('first Task\n')
      expect(yield* Effect.promise(() => readFile(join(workspace.workspace, 'wiki/second.md'), 'utf8'))).toBe('second Task\n')
      expect((yield* git(sibling.path, ['rev-parse', 'HEAD^{tree}'])).trim()).toBe((yield* git(workspace.workspace, ['rev-parse', 'HEAD^{tree}'])).trim())
      expect(yield* worktrees.ensure('task').pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      const refreshed = yield* sync.synchronize({ id: 'refresh-first-task', taskId: 'task', expectedSourceHead: first.alignedHead! })
      expect(refreshed).toMatchObject({ state: 'aligned', sourceChanges: [], sourceCommits: [] })
      expect(yield* worktrees.ensure('task')).toMatchObject({ path: task.path, branch: task.branch })
      expect((yield* git(task.path, ['rev-parse', 'HEAD^{tree}'])).trim()).toBe((yield* git(workspace.workspace, ['rev-parse', 'HEAD^{tree}'])).trim())
    }).pipe(Effect.provide(layer()))
  )
}, 20_000)

it('atomically supersedes and reprepares a concurrent operation after another Task advances main', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { workspace, task, worktrees, applications, sync, git } = yield* setup
      const sibling = yield* worktrees.create({ id: 'stale-sibling', goal: 'parallel preparation', configuration: { agent: 'pi', skillIds: [], integrationIds: [] } })
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/winner.md'), 'winner\n'))
      yield* Effect.promise(() => writeFile(join(sibling.path, 'wiki/stale.md'), 'stale candidate\n'))
      const winnerSource = yield* applications.save({ id: 'winner-save', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/winner.md'] })
      const staleSource = yield* applications.save({ id: 'stale-save', taskId: 'stale-sibling', expectedParent: sibling.baselineCommit, paths: ['wiki/stale.md'] })
      const winner = yield* sync.prepare({ id: 'winner-sync', taskId: 'task', expectedSourceHead: winnerSource.commit })
      const stale = yield* sync.prepare({ id: 'stale-sync', taskId: 'stale-sibling', expectedSourceHead: staleSource.commit })
      expect(stale.mainBase).toBe(winner.mainBase)
      expect(yield* sync.reprepare({ id: 'wrong-task-retry', taskId: 'task', supersededId: stale.id }).pipe(Effect.flip)).toMatchObject({ reason: 'not-found' })
      expect(yield* sync.reprepare({ id: 'too-early-retry', taskId: 'stale-sibling', supersededId: stale.id }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      yield* sync.publish(winner.id)
      yield* sync.align(winner.id)
      expect(yield* sync.publish(stale.id).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      expect(yield* sync.get(stale.id)).toMatchObject({ state: 'prepared', publishedHead: null })
      expect((yield* git(workspace.workspace, ['rev-parse', 'HEAD'])).trim()).toBe(winner.preparedHead)
      expect(yield* Effect.promise(() => readFile(join(sibling.path, 'wiki/stale.md'), 'utf8'))).toBe('stale candidate\n')

      yield* Effect.promise(() => writeFile(join(workspace.workspace, 'wiki/main-draft.md'), 'unsaved main\n'))
      expect(yield* sync.reprepare({ id: 'dirty-main-retry', taskId: 'stale-sibling', supersededId: stale.id }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      yield* Effect.promise(() => rm(join(workspace.workspace, 'wiki/main-draft.md')))
      yield* Effect.promise(() => writeFile(join(sibling.path, 'wiki/task-draft.md'), 'unsaved Task\n'))
      expect(yield* sync.reprepare({ id: 'dirty-task-retry', taskId: 'stale-sibling', supersededId: stale.id }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      yield* Effect.promise(() => rm(join(sibling.path, 'wiki/task-draft.md')))

      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TRIGGER fail_replacement BEFORE INSERT ON git_sync_operations
      WHEN NEW.supersedes_id='stale-sync' BEGIN SELECT RAISE(ABORT, 'fixture replacement failure'); END`
      expect(yield* sync.reprepare({ id: 'stale-sync-retry', taskId: 'stale-sibling', supersededId: stale.id }).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
      expect(yield* sync.get(stale.id)).toMatchObject({ state: 'prepared' })
      expect(yield* sync.get('stale-sync-retry').pipe(Effect.flip)).toMatchObject({ reason: 'not-found' })
      yield* sql`DROP TRIGGER fail_replacement`

      const replacement = yield* sync.reprepare({ id: 'stale-sync-retry', taskId: 'stale-sibling', supersededId: stale.id })
      expect(replacement).toMatchObject({ state: 'aligned', supersedesId: stale.id, sourceHead: stale.sourceHead })
      expect(yield* sync.reprepare({ id: 'stale-sync-retry', taskId: 'stale-sibling', supersededId: stale.id })).toEqual(replacement)
      expect(yield* sync.get(stale.id)).toMatchObject({ state: 'superseded', publishedHead: null, alignedHead: null })
      expect(yield* sync.pending).toEqual([])
      expect((yield* git(workspace.workspace, ['rev-parse', 'refs/folio/sync/stale-sync/canonical'])).trim()).toBe(stale.preparedHead)
      expect(yield* Effect.promise(() => readFile(join(workspace.workspace, 'wiki/winner.md'), 'utf8'))).toBe('winner\n')
      expect(yield* Effect.promise(() => readFile(join(workspace.workspace, 'wiki/stale.md'), 'utf8'))).toBe('stale candidate\n')
      expect((yield* git(sibling.path, ['rev-parse', 'HEAD^{tree}'])).trim()).toBe((yield* git(workspace.workspace, ['rev-parse', 'HEAD^{tree}'])).trim())
    }).pipe(Effect.provide(layer()))
  )
}, 30_000)

it('rejects an external Task commit that was not created by the save journal', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { task, sync, git } = yield* setup
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/external.md'), 'not registered\n'))
      yield* git(task.path, ['add', '--', 'wiki/external.md'])
      yield* git(task.path, ['commit', '-m', 'external commit'])
      const externalHead = (yield* git(task.path, ['rev-parse', 'HEAD'])).trim()
      expect(yield* sync.prepare({ id: 'external-sync', taskId: 'task', expectedSourceHead: externalHead }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      expect(yield* sync.pending).toEqual([])
      expect((yield* git(task.path, ['rev-parse', 'HEAD'])).trim()).toBe(externalHead)
    }).pipe(Effect.provide(layer()))
  )
}, 15_000)

it('rejects registered Task changes outside wiki from the narrowed synchronization slice', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { workspace, task, applications, sync, git } = yield* setup
      const mainAgents = yield* Effect.promise(() => readFile(join(workspace.workspace, 'AGENTS.md'), 'utf8'))
      yield* Effect.promise(() => writeFile(join(task.path, 'AGENTS.md'), 'Task-only instructions\n'))
      const source = yield* applications.save({ id: 'agents-save', taskId: 'task', expectedParent: task.baselineCommit, paths: ['AGENTS.md'] })
      expect(yield* sync.prepare({ id: 'agents-sync', taskId: 'task', expectedSourceHead: source.commit }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      expect(yield* sync.pending).toEqual([])
      expect(yield* Effect.promise(() => readFile(join(workspace.workspace, 'AGENTS.md'), 'utf8'))).toBe(mainAgents)
      expect((yield* git(task.path, ['rev-parse', 'HEAD'])).trim()).toBe(source.commit)
    }).pipe(Effect.provide(layer()))
  )
}, 15_000)

it('rejects an operation inserted directly at a completed checkpoint', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { task } = yield* setup
      const sql = yield* SqlClient.SqlClient
      expect(
        yield* sql`INSERT INTO git_sync_operations
        (id, task_id, source_frontier, source_head, source_changes, source_commits, main_base, state, created_at)
        VALUES ('forged-sync', 'task', ${task.baselineCommit}, ${task.baselineCommit}, '[]', '[]', ${task.baselineCommit}, 'aligned', 0)`.pipe(Effect.flip)
      ).toMatchObject({ _tag: 'SqlError' })
      expect(yield* sql`SELECT id FROM git_sync_operations WHERE id='forged-sync'`).toEqual([])
    }).pipe(Effect.provide(layer()))
  )
})

it('retains a conflicted coordinator unchanged across restart and retry', async () => {
  const conflict = await Effect.runPromise(
    Effect.gen(function* () {
      const { workspace, task, applications, sync } = yield* setup
      yield* Effect.promise(() => writeFile(join(task.path, 'wiki/restart-conflict.md'), 'Task version\n'))
      const source = yield* applications.save({ id: 'restart-task-save', taskId: 'task', expectedParent: task.baselineCommit, paths: ['wiki/restart-conflict.md'] })
      yield* Effect.promise(() => writeFile(join(workspace.workspace, 'wiki/restart-conflict.md'), 'main version\n'))
      yield* applications.save({ id: 'restart-main-save', taskId: null, expectedParent: task.baselineCommit, paths: ['wiki/restart-conflict.md'] })
      const operation = yield* sync.prepare({ id: 'restart-conflict-sync', taskId: 'task', expectedSourceHead: source.commit })
      expect(operation.state).toBe('conflict')
      return { source, contents: yield* Effect.promise(() => readFile(join(root, 'sync-worktrees/restart-conflict-sync/wiki/restart-conflict.md'), 'utf8')) }
    }).pipe(Effect.provide(layer()))
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const sync = yield* TaskGitSynchronization
      const retried = yield* sync.prepare({ id: 'restart-conflict-sync', taskId: 'task', expectedSourceHead: conflict.source.commit })
      expect(retried.state).toBe('conflict')
      expect(yield* Effect.promise(() => readFile(join(root, 'sync-worktrees/restart-conflict-sync/wiki/restart-conflict.md'), 'utf8'))).toBe(conflict.contents)
    }).pipe(Effect.provide(layer()))
  )
}, 15_000)
