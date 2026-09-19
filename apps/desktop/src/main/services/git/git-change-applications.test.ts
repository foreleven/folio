import { reserveClaimedRun, finishClaimedRun } from '../testing/claimed-run'
import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Layer, ManagedRuntime } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { GitChangeApplications, isRegisteredGitCommit } from './git-change-applications'
import { GitChangeJournal } from './git-change-journal'
import { snapshotGitChange } from './git-change-snapshot'
import { HarnessStore } from '../harness/harness-store'
import { TaskWorktrees } from '../tasks/task-worktrees'
import { vaultDatabaseLayer } from '../vault/vault-database'
import { makeVaultGit } from './vault-git'
import { initializeVaultWorkspace } from '../vault/vault-workspace'
import { VaultGitWriteLock } from './vault-git-write-lock'
import type { SaveGitFiles } from '../../../shared/git-change'

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'folio-git-save-')))
  await mkdir(join(root, 'entry'))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
/** Tests reopen real SQL/Git state; the optional failure affects only publication of the real index. */
function layer(failIndex = false) {
  const platform = failIndex ? Layer.effect(FileSystem.FileSystem, Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return FileSystem.FileSystem.of({ ...fs, rename: (from, to) =>
      fs.rename(from.endsWith('/index.lock') ? join(root, 'missing-fixture-index') : from, to) })
  })).pipe(Layer.provideMerge(NodeServices.layer)) : NodeServices.layer
  return Layer.mergeAll(GitChangeApplications.layer(root), TaskWorktrees.layer(root), VaultGitWriteLock.layer(root)).pipe(
    Layer.provideMerge(GitChangeJournal.layer(root)), Layer.provideMerge(HarnessStore.layer),
    Layer.provideMerge(vaultDatabaseLayer(root)), Layer.provideMerge(platform))
}
/** The saved tree predates later working-file edits and excludes an unrelated staged draft. */
const setup = Effect.gen(function*() {
  const main = yield* initializeVaultWorkspace(root, join(root, 'entry'))
  const git = yield* makeVaultGit
  yield* Effect.promise(async () => {
    await writeFile(join(main.wiki, 'note.md'), 'saved note')
    await writeFile(join(main.wiki, 'draft.md'), 'unselected staged draft')
  })
  yield* git(main.workspace, ['add', '--', 'wiki/draft.md'])
  const snapshot = yield* snapshotGitChange({ cwd: main.workspace, parent: main.initialCommit, paths: ['wiki/note.md'] })
  const journal = yield* GitChangeJournal
  const change = yield* journal.prepare({ id: 'save', taskId: null, runIds: [], kind: 'user',
    parent: snapshot.parent, tree: snapshot.tree, paths: ['wiki/note.md'] })
  return { main, git, journal, change, applications: yield* GitChangeApplications }
})

it('applies only the selected snapshot, preserves staged/working drafts and registers the next Task baseline', async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const { main, change, applications, git, journal } = yield* setup
    yield* Effect.promise(() => writeFile(join(main.wiki, 'note.md'), 'newer unsaved edit'))
    expect(yield* applications.apply(change.id)).toMatchObject({ commit: change.commit, state: 'applied', branch: 'main' })
    expect((yield* git(main.workspace, ['rev-parse', 'HEAD'])).trim()).toBe(change.commit)
    expect(yield* git(main.workspace, ['show', 'HEAD:wiki/note.md'])).toBe('saved note')
    expect(yield* git(main.workspace, ['show', ':wiki/draft.md'])).toBe('unselected staged draft')
    expect((yield* git(main.workspace, ['diff', '--cached', '--name-only'])).trim()).toBe('wiki/draft.md')
    expect(yield* Effect.promise(() => readFile(join(main.wiki, 'note.md'), 'utf8'))).toBe('newer unsaved edit')
    const worktrees = yield* TaskWorktrees
    const task = yield* worktrees.create({ id: 'task', goal: 'notes', configuration: { agent: 'pi', skillIds: [], integrationIds: [] } })
    expect(task.baselineCommit).toBe(change.commit)
    expect(yield* Effect.promise(() => readFile(join(task.path, 'wiki/note.md'), 'utf8'))).toBe('saved note')
    yield* Effect.promise(() => expect(readFile(join(task.path, 'wiki/draft.md'))).rejects.toMatchObject({ code: 'ENOENT' }))
    // A later registered save can delete just this file; the previous receipt stays an immutable checkpoint.
    yield* Effect.promise(() => rm(join(main.wiki, 'note.md')))
    const deletion = yield* snapshotGitChange({ cwd: main.workspace, parent: change.commit, paths: ['wiki/note.md'] })
    const next = yield* journal.prepare({ id: 'delete', taskId: null, runIds: [], kind: 'user',
      parent: deletion.parent, tree: deletion.tree, paths: ['wiki/note.md'] })
    expect(yield* applications.apply(next.id)).toMatchObject({ state: 'applied', commit: next.commit })
    expect(yield* applications.apply(change.id)).toMatchObject({ state: 'applied', commit: change.commit })
    expect((yield* git(main.workspace, ['rev-parse', 'HEAD'])).trim()).toBe(next.commit)
    expect((yield* git(main.workspace, ['diff', '--cached', '--name-only'])).trim()).toBe('wiki/draft.md')
  }).pipe(Effect.provide(layer())))
}, 15_000) // Two real saves plus worktree creation can exceed Vitest's 5-second default during the full suite.

it.each(['ref', 'index', 'receipt'] as const)('recovers the %s write boundary after reopening without duplicate commits', async boundary => {
  const saved = await Effect.runPromise(Effect.gen(function*() {
    const { main, change, applications, git } = yield* setup
    const before = yield* Effect.promise(() => readFile(join(main.workspace, '.git/index')))
    const sql = yield* SqlClient.SqlClient
    if (boundary === 'ref') yield* Effect.promise(() => writeFile(join(main.workspace, '.git/refs/heads/main.lock'), 'fixture'))
    if (boundary === 'receipt') yield* sql`CREATE TRIGGER fail_receipt BEFORE UPDATE OF state ON git_change_applications
      WHEN NEW.state='applied' BEGIN SELECT RAISE(ABORT, 'fixture lost receipt'); END`
    expect(yield* applications.apply(change.id).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
    expect(yield* applications.pending).toMatchObject([{ id: change.id, state: 'applying' }])
    expect((yield* git(main.workspace, ['rev-parse', 'HEAD'])).trim()).toBe(boundary === 'ref' ? change.parent : change.commit)
    if (boundary !== 'receipt') expect(yield* Effect.promise(() => readFile(join(main.workspace, '.git/index')))).toEqual(before)
    if (boundary === 'receipt') yield* sql`DROP TRIGGER fail_receipt`
    return change
  }).pipe(Effect.provide(layer(boundary === 'index'))))
  if (boundary === 'ref') await rm(join(root, 'workspace/.git/refs/heads/main.lock'))
  await writeFile(join(root, 'workspace/wiki/note.md'), 'later editor text')
  await Effect.runPromise(Effect.gen(function*() {
    const applications = yield* GitChangeApplications
    const git = yield* makeVaultGit
    expect(yield* applications.recover(saved.id)).toMatchObject({ commit: saved.commit, state: 'applied' })
    expect(yield* applications.recover(saved.id)).toMatchObject({ commit: saved.commit, state: 'applied' })
    expect((yield* git(join(root, 'workspace'), ['rev-list', '--count', 'HEAD'])).trim()).toBe('2')
    expect(yield* git(join(root, 'workspace'), ['show', ':wiki/draft.md'])).toBe('unselected staged draft')
    expect(yield* Effect.promise(() => readFile(join(root, 'workspace/wiki/note.md'), 'utf8'))).toBe('later editor text')
    expect(yield* applications.pending).toEqual([])
  }).pipe(Effect.provide(layer())))
})

it('refuses an unrelated index lock without deleting it or changing HEAD', async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const { main, change, applications, git } = yield* setup
    yield* Effect.promise(() => writeFile(join(main.workspace, '.git/index.lock'), 'another process owns this'))
    expect(yield* applications.apply(change.id).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    expect(yield* Effect.promise(() => readFile(join(main.workspace, '.git/index.lock'), 'utf8'))).toBe('another process owns this')
    expect((yield* git(main.workspace, ['rev-parse', 'HEAD'])).trim()).toBe(change.parent)
  }).pipe(Effect.provide(layer())))
})

it('keeps newer index edits intact when the prior receipt was lost', async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const { main, change, applications, git } = yield* setup
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TRIGGER fail_receipt BEFORE UPDATE OF state ON git_change_applications
      WHEN NEW.state='applied' BEGIN SELECT RAISE(ABORT, 'fixture lost receipt'); END`
    yield* applications.apply(change.id).pipe(Effect.flip)
    yield* sql`DROP TRIGGER fail_receipt`
    yield* Effect.promise(() => writeFile(join(main.wiki, 'draft.md'), 'newer staged version'))
    yield* git(main.workspace, ['add', '--', 'wiki/draft.md'])
    const before = yield* Effect.promise(() => readFile(join(main.workspace, '.git/index')))
    expect(yield* applications.recover(change.id).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    expect(yield* Effect.promise(() => readFile(join(main.workspace, '.git/index')))).toEqual(before)
  }).pipe(Effect.provide(layer())))
})

it('recovers a lost receipt after Git refreshes index metadata, preserving the newer index bytes', async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const { main, change, applications, git } = yield* setup
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TRIGGER fail_receipt BEFORE UPDATE OF state ON git_change_applications
      WHEN NEW.state='applied' BEGIN SELECT RAISE(ABORT, 'fixture lost receipt'); END`
    yield* applications.apply(change.id).pipe(Effect.flip)
    yield* sql`DROP TRIGGER fail_receipt`
    const saved = yield* Effect.promise(() => readFile(join(main.workspace, '.git/index')))
    yield* Effect.promise(() => writeFile(join(main.wiki, 'note.md'), 'saved note'))
    yield* git(main.workspace, ['update-index', '--refresh'])
    const refreshed = yield* Effect.promise(() => readFile(join(main.workspace, '.git/index')))
    expect(refreshed).not.toEqual(saved)
    expect(yield* applications.recover(change.id)).toMatchObject({ state: 'applied' })
    expect(yield* Effect.promise(() => readFile(join(main.workspace, '.git/index')))).toEqual(refreshed)
  }).pipe(Effect.provide(layer())))
})

it('uses a separate nonblocking process lock while the Vault event database remains writable', async () => {
  await Effect.runPromise(setup.pipe(Effect.provide(layer())))
  const first = ManagedRuntime.make(layer())
  const second = ManagedRuntime.make(layer())
  try {
    const owner = await first.runPromise(VaultGitWriteLock)
    const contender = await second.runPromise(VaultGitWriteLock)
    await first.runPromise(owner.withLock(Effect.gen(function*() {
      const error = yield* Effect.promise(() => second.runPromise(contender.withLock(Effect.void).pipe(Effect.flip)))
      expect(error).toMatchObject({ reason: 'task-busy' })
      // Actual writes in data.db still complete while git-write-lock.db is reserved.
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE event_lock_probe (id INTEGER PRIMARY KEY)`
      yield* sql`INSERT INTO event_lock_probe VALUES (1)`
    }).pipe(Effect.orDie)))
    await second.runPromise(contender.withLock(Effect.void))
  } finally { await first.dispose(); await second.dispose() }
})

it('serializes independent save callers and retries the same commit once the other caller finishes', async () => {
  const change = await Effect.runPromise(setup.pipe(Effect.map(value => value.change), Effect.provide(layer())))
  const first = ManagedRuntime.make(layer())
  const second = ManagedRuntime.make(layer())
  try {
    const a = await first.runPromise(GitChangeApplications)
    const b = await second.runPromise(GitChangeApplications)
    const results = await Promise.allSettled([first.runPromise(a.apply(change.id)), second.runPromise(b.apply(change.id))])
    expect(results.some(result => result.status === 'fulfilled')).toBe(true)
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ reason: 'task-busy' })
      else expect(result.value).toMatchObject({ commit: change.commit, state: 'applied' })
    }
    expect(await first.runPromise(a.apply(change.id))).toEqual(await second.runPromise(b.apply(change.id)))
  } finally { await first.dispose(); await second.dispose() }
})

it('blocks Run admission across an unfinished Task save, then registers its committed baseline', async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const { applications, journal, git } = yield* setup
    const worktrees = yield* TaskWorktrees
    const store = yield* HarnessStore
    const task = yield* worktrees.create({ id: 'task', goal: 'notes', configuration: { agent: 'pi', skillIds: [], integrationIds: [] } })
    yield* store.createSession({ id: 'session', taskId: 'task', agent: 'pi', adapterVersion: '1', purpose: 'task', syncOperationId: null })
    yield* store.bindSession('session', { acpSessionId: 'acp', nativeSessionId: null })
    yield* Effect.promise(() => writeFile(join(task.path, 'wiki/task.md'), 'task progress'))
    const snapshot = yield* snapshotGitChange({ cwd: task.path, parent: task.baselineCommit, paths: ['wiki/task.md'] })
    const saved = yield* journal.prepare({ id: 'task-save', taskId: 'task', runIds: [], kind: 'user',
      parent: snapshot.parent, tree: snapshot.tree, paths: ['wiki/task.md'] })
    const run = { id: 'run', taskId: 'task', sessionId: 'session', prompt: 'notes', purpose: 'execution' as const,
      resumesRunId: null, baselineCommit: task.baselineCommit }
    yield* reserveClaimedRun(run)
    expect(yield* applications.apply(saved.id).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    yield* finishClaimedRun(run.id, 'failed')
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TRIGGER fail_task_receipt BEFORE UPDATE OF state ON git_change_applications
      WHEN NEW.state='applied' BEGIN SELECT RAISE(ABORT, 'fixture lost Task receipt'); END`
    yield* applications.apply(saved.id).pipe(Effect.flip)
    expect(yield* isRegisteredGitCommit(task.branch, saved.commit, task.baselineCommit)).toBe(false)
    expect(yield* reserveClaimedRun({ ...run, id: 'blocked' }).pipe(Effect.flip)).toMatchObject({ reason: 'task-busy' })
    expect(yield* worktrees.ensure('task').pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    yield* sql`DROP TRIGGER fail_task_receipt`
    expect(yield* applications.recover(saved.id)).toMatchObject({ state: 'applied' })
    expect(yield* isRegisteredGitCommit(task.branch, saved.commit, task.baselineCommit)).toBe(true)
    expect((yield* git(task.path, ['rev-parse', 'HEAD'])).trim()).toBe(saved.commit)
    yield* reserveClaimedRun({ ...run, id: 'next', baselineCommit: saved.commit })
  }).pipe(Effect.provide(layer())))
})

it('refuses an unregistered parent and leaves the index and branch intact', async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const { main, journal, git, applications } = yield* setup
    yield* git(main.workspace, ['commit', '--only', '--allow-empty', '-m', 'external commit'])
    const parent = (yield* git(main.workspace, ['rev-parse', 'HEAD'])).trim()
    const snapshot = yield* snapshotGitChange({ cwd: main.workspace, parent, paths: ['wiki/note.md'] })
    const change = yield* journal.prepare({ id: 'external-parent', kind: 'user', taskId: null, runIds: [],
      parent, tree: snapshot.tree, paths: ['wiki/note.md'] })
    const before = yield* Effect.promise(() => readFile(join(main.workspace, '.git/index')))
    expect(yield* applications.apply(change.id).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    expect((yield* git(main.workspace, ['rev-parse', 'HEAD'])).trim()).toBe(parent)
    expect(yield* Effect.promise(() => readFile(join(main.workspace, '.git/index')))).toEqual(before)
  }).pipe(Effect.provide(layer())))
})

it('saves a binary file with a literal newline/pathspec name without adding other drafts', async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const { main, journal, git, applications } = yield* setup
    const path = 'wiki/:binary\n[draft].bin'
    yield* Effect.promise(() => writeFile(join(main.workspace, path), Buffer.from([0, 255, 128, 13, 10, 2])))
    const expected = (yield* git(main.workspace, ['hash-object', '--no-filters', '--', path])).trim()
    const snapshot = yield* snapshotGitChange({ cwd: main.workspace, parent: main.initialCommit, paths: [path] })
    const change = yield* journal.prepare({ id: 'binary', kind: 'user', taskId: null, runIds: [],
      parent: snapshot.parent, tree: snapshot.tree, paths: [path] })
    yield* applications.apply(change.id)
    expect((yield* git(main.workspace, ['rev-parse', `HEAD:${path}`])).trim()).toBe(expected)
    expect((yield* git(main.workspace, ['rev-parse', `:${path}`])).trim()).toBe(expected)
    expect((yield* git(main.workspace, ['diff', '--cached', '--name-only'])).trim()).toBe('wiki/draft.md')
  }).pipe(Effect.provide(layer())))
})

it('does not discard an unselected staged descendant when the selected file replaces its directory', async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const { main, journal, git, applications } = yield* setup
    yield* Effect.promise(async () => {
      await mkdir(join(main.wiki, 'collision'))
      await writeFile(join(main.wiki, 'collision/child.md'), 'unselected staged child')
    })
    yield* git(main.workspace, ['add', '--', 'wiki/collision/child.md'])
    yield* Effect.promise(async () => {
      await rm(join(main.wiki, 'collision'), { recursive: true })
      await writeFile(join(main.wiki, 'collision'), 'selected replacement file')
    })
    const snapshot = yield* snapshotGitChange({ cwd: main.workspace, parent: main.initialCommit, paths: ['wiki/collision'] })
    const change = yield* journal.prepare({ id: 'collision', taskId: null, runIds: [], kind: 'user',
      parent: snapshot.parent, tree: snapshot.tree, paths: ['wiki/collision'] })
    const before = yield* Effect.promise(() => readFile(join(main.workspace, '.git/index')))
    expect(yield* applications.apply(change.id).pipe(Effect.flip)).toBeDefined()
    expect(yield* Effect.promise(() => readFile(join(main.workspace, '.git/index')))).toEqual(before)
    expect((yield* git(main.workspace, ['rev-parse', 'HEAD'])).trim()).toBe(main.initialCommit)
  }).pipe(Effect.provide(layer())))
})

it('cannot acquire a live process lock and can save after the owner process exits abruptly', async () => {
  const runtime = ManagedRuntime.make(layer())
  const { applications, change } = await runtime.runPromise(setup)
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); process.stdout.write('locked'); setInterval(() => {}, 1000);",
    join(root, 'git-write-lock.db')], { stdio: ['ignore', 'pipe', 'ignore'] })
  const exited = once(child, 'exit')
  try {
    await Promise.race([once(child.stdout, 'data'), exited.then(() => { throw new Error('Lock fixture exited before readiness') })])
    expect(await runtime.runPromise(applications.apply(change.id).pipe(Effect.flip))).toMatchObject({ reason: 'task-busy' })
    child.kill('SIGKILL')
    await exited
    expect(await runtime.runPromise(applications.apply(change.id))).toMatchObject({ state: 'applied', commit: change.commit })
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
    await runtime.dispose()
  }
})

it('captures and applies a selected user save through one gate and reuses the accepted result', async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const { main, applications, git } = yield* setup
    const request: SaveGitFiles = { id: 'coordinated', taskId: null, expectedParent: main.initialCommit, paths: ['wiki/note.md'] }
    const saved = yield* applications.save(request)
    expect(saved.state).toBe('applied')
    expect(yield* git(main.workspace, ['show', 'HEAD:wiki/note.md'])).toBe('saved note')
    expect((yield* git(main.workspace, ['diff', '--cached', '--name-only'])).trim()).toBe('wiki/draft.md')
    yield* Effect.promise(() => writeFile(join(main.wiki, 'note.md'), 'newer edit after accepted save'))
    expect(yield* applications.save({ ...request, paths: ['wiki/note.md', 'wiki/note.md'] })).toEqual(saved)
    expect(yield* applications.save({ ...request, paths: ['wiki/draft.md'] }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    expect(yield* applications.save({ ...request, expectedParent: saved.commit }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    expect(yield* Effect.promise(() => readFile(join(main.wiki, 'note.md'), 'utf8'))).toBe('newer edit after accepted save')
    expect((yield* git(main.workspace, ['rev-list', '--count', 'HEAD'])).trim()).toBe('2')
  }).pipe(Effect.provide(layer())))
})

it.each(['application-intent', 'receipt'] as const)('retries an accepted save after %s failure without capturing newer files', async boundary => {
  const request = await Effect.runPromise(Effect.gen(function*() {
    const { main, applications } = yield* setup
    const sql = yield* SqlClient.SqlClient
    if (boundary === 'application-intent') yield* sql`CREATE TRIGGER fail_save BEFORE INSERT ON git_change_applications
      BEGIN SELECT RAISE(ABORT, 'fixture application intent failure'); END`
    else yield* sql`CREATE TRIGGER fail_save BEFORE UPDATE OF state ON git_change_applications WHEN NEW.state='applied'
      BEGIN SELECT RAISE(ABORT, 'fixture application receipt failure'); END`
    const input: SaveGitFiles = { id: 'retry-save', taskId: null, expectedParent: main.initialCommit, paths: ['wiki/note.md'] }
    expect(yield* applications.save(input).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
    yield* sql`DROP TRIGGER fail_save`
    return input
  }).pipe(Effect.provide(layer())))
  await writeFile(join(root, 'workspace/wiki/note.md'), 'newer worktree text')
  await Effect.runPromise(Effect.gen(function*() {
    const applications = yield* GitChangeApplications
    const journal = yield* GitChangeJournal
    const git = yield* makeVaultGit
    const original = yield* journal.get(request.id)
    expect(yield* applications.save(request)).toMatchObject({ commit: original.commit, state: 'applied' })
    expect(yield* git(join(root, 'workspace'), ['show', 'HEAD:wiki/note.md'])).toBe('saved note')
    expect(yield* Effect.promise(() => readFile(join(root, 'workspace/wiki/note.md'), 'utf8'))).toBe('newer worktree text')
  }).pipe(Effect.provide(layer())))
})

it('rejects stale save baselines and invalid file scopes before accepting another change', async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const { main, applications, journal } = yield* setup
    const saved = yield* applications.save({ id: 'first-save', taskId: null, expectedParent: main.initialCommit, paths: ['wiki/note.md'] })
    for (const [id, parent, paths] of [
      ['stale-save', main.initialCommit, ['wiki/draft.md']],
      ['invalid-path', saved.commit, ['../outside']]
    ] as const) {
      expect(yield* applications.save({ id, taskId: null, expectedParent: parent, paths }).pipe(Effect.flip)).toBeDefined()
      expect(yield* journal.get(id).pipe(Effect.flip)).toMatchObject({ reason: 'not-found' })
    }
  }).pipe(Effect.provide(layer())))
})

it('records an explicit no-wiki-change receipt only for a clean successful Run baseline', async () => {
  await Effect.runPromise(Effect.gen(function*() {
    yield* initializeVaultWorkspace(root, join(root, 'entry'))
    const worktrees = yield* TaskWorktrees
    const task = yield* worktrees.create({ id: 'unchanged-task', goal: 'inspect notes', configuration: { agent: 'pi', skillIds: [], integrationIds: [] } })
    const store = yield* HarnessStore
    yield* store.createSession({ id: 'unchanged-session', taskId: 'unchanged-task', agent: 'pi', adapterVersion: '1', purpose: 'task', syncOperationId: null })
    yield* store.bindSession('unchanged-session', { acpSessionId: 'unchanged-acp', nativeSessionId: null })
    const run = { id: 'unchanged-run', taskId: 'unchanged-task', sessionId: 'unchanged-session', prompt: 'inspect', purpose: 'execution' as const,
      resumesRunId: null, baselineCommit: task.baselineCommit }
    yield* reserveClaimedRun(run)
    yield* finishClaimedRun(run.id, 'succeeded')
    const applications = yield* GitChangeApplications
    const input = { taskId: run.taskId, runId: run.id, expectedHead: task.baselineCommit }

    expect(yield* store.runs(run.taskId)).toMatchObject([{ id: run.id, state: 'succeeded', syncState: 'pending' }])
    const accepted = yield* applications.confirmRunWikiUnchanged(input)
    expect(accepted).toMatchObject({ id: run.id, state: 'succeeded', syncState: 'not-required', baselineCommit: task.baselineCommit })
    expect(yield* applications.confirmRunWikiUnchanged(input)).toEqual(accepted)
    expect(yield* applications.confirmRunWikiUnchanged({ ...input, expectedHead: '0'.repeat(40) }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })

    const changed = { ...run, id: 'changed-run' }
    yield* reserveClaimedRun(changed)
    yield* Effect.promise(() => writeFile(join(task.path, 'wiki/output.md'), 'unsaved output'))
    yield* finishClaimedRun(changed.id, 'succeeded')
    expect(yield* applications.confirmRunWikiUnchanged({ ...input, runId: changed.id }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    expect((yield* store.runs(run.taskId)).find((candidate) => candidate.id === changed.id)?.syncState).toBe('pending')
    const snapshot = yield* snapshotGitChange({ cwd: task.path, parent: task.baselineCommit, paths: ['wiki/output.md'] })
    yield* (yield* GitChangeJournal).prepare({
      id: 'pending-run-save',
      taskId: run.taskId,
      runIds: [changed.id],
      kind: 'wiki',
      parent: snapshot.parent,
      tree: snapshot.tree,
      paths: ['wiki/output.md']
    })
    yield* Effect.promise(() => rm(join(task.path, 'wiki/output.md')))
    expect(yield* applications.confirmRunWikiUnchanged({ ...input, runId: changed.id }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
  }).pipe(Effect.provide(layer())))
})
