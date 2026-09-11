import { NodeServices } from '@effect/platform-node'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { GitChangeIntent } from '../../shared/git-change'
import { GitChangeJournal } from './git-change-journal'
import { snapshotGitChange } from './git-change-snapshot'
import { HarnessStore } from './harness-store'
import { TaskWorktrees } from './task-worktrees'
import { vaultDatabaseLayer } from './vault-database'
import { makeVaultGit } from './vault-git'
import { initializeVaultWorkspace } from './vault-workspace'

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'folio-change-journal-')))
  await mkdir(join(root, 'entry'))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
/** Reopening creates independent service/SQLite lifetimes over the same real Git repository. */
function layer() {
  return Layer.mergeAll(GitChangeJournal.layer(root), TaskWorktrees.layer(root)).pipe(
    Layer.provideMerge(HarnessStore.layer), Layer.provideMerge(vaultDatabaseLayer(root)), Layer.provideMerge(NodeServices.layer))
}
/** Prepares a user-selected file tree without updating the source branch or index. */
const setup = Effect.gen(function*() {
  const main = yield* initializeVaultWorkspace(root, join(root, 'entry'))
  yield* Effect.promise(() => writeFile(join(main.wiki, 'note.md'), 'selected content'))
  const snapshot = yield* snapshotGitChange({ cwd: main.workspace, parent: main.initialCommit, paths: ['wiki/note.md'] })
  const input: GitChangeIntent = { id: 'change', taskId: null, runIds: [], kind: 'user',
    parent: snapshot.parent, tree: snapshot.tree, paths: ['wiki/note.md'] }
  return { main, input, git: yield* makeVaultGit, journal: yield* GitChangeJournal }
})

it('retains a stable commit and its original file selection across restart without applying it', async () => {
  const saved = await Effect.runPromise(Effect.gen(function*() {
    const { main, input, git, journal } = yield* setup
    yield* Effect.promise(() => writeFile(join(main.wiki, 'draft.md'), 'unselected staged draft'))
    yield* git(main.workspace, ['add', '--', 'wiki/draft.md'])
    const index = yield* Effect.promise(() => readFile(join(main.workspace, '.git/index')))
    const result = yield* journal.prepare(input)
    expect(result.state).toBe('prepared')
    expect((yield* git(main.workspace, ['rev-parse', 'refs/folio/changes/change'])).trim()).toBe(result.commit)
    expect((yield* git(main.workspace, ['show', '-s', '--format=%P', result.commit])).trim()).toBe(input.parent)
    expect(yield* git(main.workspace, ['show', `${result.commit}:wiki/note.md`])).toBe('selected content')
    expect(yield* git(main.workspace, ['show', '-s', '--format=%B', result.commit])).toContain('Folio-Change-Id: change')
    expect((yield* git(main.workspace, ['rev-parse', 'HEAD'])).trim()).toBe(input.parent)
    expect(yield* Effect.promise(() => readFile(join(main.workspace, '.git/index')))).toEqual(index)
    return { input, result }
  }).pipe(Effect.provide(layer())))
  await writeFile(join(root, 'workspace/wiki/note.md'), 'newer unsaved text')
  await Effect.runPromise(Effect.gen(function*() {
    const journal = yield* GitChangeJournal
    expect(yield* journal.prepare({ ...saved.input, paths: ['wiki/note.md', 'wiki/note.md'] })).toEqual(saved.result)
    expect(yield* journal.get('change')).toEqual(saved.result)
    expect(yield* journal.prepare({ ...saved.input, paths: ['wiki/note.md', 'wiki/other.md'] }).pipe(Effect.flip))
      .toMatchObject({ reason: 'invalid-state' })
    expect(yield* Effect.promise(() => readFile(join(root, 'workspace/wiki/note.md'), 'utf8'))).toBe('newer unsaved text')
  }).pipe(Effect.provide(layer())))
})

it('recovers Git success before a lost SQLite receipt even after HEAD moves, without duplicate commits', async () => {
  const saved = await Effect.runPromise(Effect.gen(function*() {
    const { main, input, git, journal } = yield* setup
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TRIGGER fail_prepared BEFORE UPDATE OF state ON git_change_preparations
      BEGIN SELECT RAISE(ABORT, 'fixture lost receipt'); END`
    expect(yield* journal.prepare(input).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
    const row = yield* journal.get(input.id)
    expect(row.state).toBe('preparing')
    expect((yield* git(main.workspace, ['rev-parse', 'refs/folio/changes/change'])).trim()).toBe(row.commit)
    yield* git(main.workspace, ['commit', '--allow-empty', '-m', 'unrelated later HEAD'])
    yield* sql`DROP TRIGGER fail_prepared`
    return row
  }).pipe(Effect.provide(layer())))
  await Effect.runPromise(Effect.gen(function*() {
    const journal = yield* GitChangeJournal
    const git = yield* makeVaultGit
    const main = join(root, 'workspace')
    const before = yield* git(main, ['rev-parse', 'HEAD'])
    expect(yield* journal.pending).toEqual([saved])
    expect(yield* journal.recover(saved.id)).toEqual({ ...saved, state: 'prepared' })
    expect(yield* journal.recover(saved.id)).toEqual({ ...saved, state: 'prepared' })
    expect(yield* git(main, ['rev-parse', 'HEAD'])).toBe(before)
    expect((yield* git(main, ['rev-list', '--count', '--all'])).trim()).toBe('3')
    expect(yield* journal.pending).toEqual([])
  }).pipe(Effect.provide(layer())))
})

it('does not write a retention ref when durable intent fails and refuses to replace mismatched refs', async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const { main, input, git, journal } = yield* setup
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TRIGGER fail_intent BEFORE INSERT ON git_change_preparations
      BEGIN SELECT RAISE(ABORT, 'fixture intent failure'); END`
    expect(yield* journal.prepare(input).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
    expect(yield* journal.get(input.id).pipe(Effect.flip)).toMatchObject({ reason: 'not-found' })
    expect((yield* git(main.workspace, ['for-each-ref', '--format=%(refname)', 'refs/folio/changes/'])).trim()).toBe('')
    yield* sql`DROP TRIGGER fail_intent`
    yield* git(main.workspace, ['update-ref', 'refs/folio/changes/change', input.parent])
    expect(yield* journal.prepare(input).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    expect((yield* journal.get(input.id)).state).toBe('preparing')
    expect((yield* git(main.workspace, ['rev-parse', 'refs/folio/changes/change'])).trim()).toBe(input.parent)
    expect(yield* journal.recover(input.id).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
  }).pipe(Effect.provide(layer())))
})

it('coalesces identical concurrent preparations from independent database connections', async () => {
  const input = await Effect.runPromise(setup.pipe(Effect.map(value => value.input), Effect.provide(layer())))
  const left = ManagedRuntime.make(layer())
  const right = ManagedRuntime.make(layer())
  try {
    // Initialize both layers before racing writes so migration acquisition is not the subject.
    const first = await left.runPromise(GitChangeJournal)
    const second = await right.runPromise(GitChangeJournal)
    const results = await Promise.all([left.runPromise(first.prepare(input)), right.runPromise(second.prepare(input))])
    expect(results[0]).toEqual(results[1])
    expect(results[0].state).toBe('prepared')
  } finally { await left.dispose(); await right.dispose() }
})

it('recreates the exact commit after a ref-write interruption without rereading newer working files', async () => {
  const saved = await Effect.runPromise(Effect.gen(function*() {
    const { input, journal } = yield* setup
    yield* Effect.promise(async () => {
      await mkdir(join(root, 'workspace/.git/refs/folio/changes'), { recursive: true })
      await writeFile(join(root, 'workspace/.git/refs/folio/changes/change.lock'), 'fixture owns this lock')
    })
    expect(yield* journal.prepare(input).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
    const row = yield* journal.get(input.id)
    expect(row.state).toBe('preparing')
    return row
  }).pipe(Effect.provide(layer())))
  // Both the lock and loose object belong to this test's temporary repository.
  await rm(join(root, 'workspace/.git/refs/folio/changes/change.lock'))
  await rm(join(root, 'workspace/.git/objects', saved.commit.slice(0, 2), saved.commit.slice(2)))
  await writeFile(join(root, 'workspace/wiki/note.md'), 'newer draft')
  await Effect.runPromise(Effect.gen(function*() {
    const journal = yield* GitChangeJournal
    const git = yield* makeVaultGit
    expect(yield* journal.recover(saved.id)).toEqual({ ...saved, state: 'prepared' })
    expect(yield* git(join(root, 'workspace'), ['show', `${saved.commit}:wiki/note.md`])).toBe('selected content')
    expect(yield* Effect.promise(() => readFile(join(root, 'workspace/wiki/note.md'), 'utf8'))).toBe('newer draft')
  }).pipe(Effect.provide(layer())))
})

it('retains an incomplete journal when its original tree is missing instead of capturing new content', async () => {
  const saved = await Effect.runPromise(Effect.gen(function*() {
    const { input, journal, git, main } = yield* setup
    // A ref mismatch leaves the durable intent incomplete without changing this existing ref.
    yield* git(main.workspace, ['update-ref', 'refs/folio/changes/change', input.parent])
    yield* journal.prepare(input).pipe(Effect.flip)
    return yield* journal.get(input.id)
  }).pipe(Effect.provide(layer())))
  await rm(join(root, 'workspace/.git/objects', saved.tree.slice(0, 2), saved.tree.slice(2)))
  await writeFile(join(root, 'workspace/wiki/note.md'), 'newer content must not replace the saved tree')
  await Effect.runPromise(Effect.gen(function*() {
    const journal = yield* GitChangeJournal
    expect(yield* journal.recover(saved.id).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
    expect(yield* journal.get(saved.id)).toEqual(saved)
    expect(yield* Effect.promise(() => readFile(join(root, 'workspace/wiki/note.md'), 'utf8')))
      .toBe('newer content must not replace the saved tree')
  }).pipe(Effect.provide(layer())))
})

it('does not follow replacement objects or a symbolic retention ref into another branch', async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const { main, input, journal, git } = yield* setup
    const first = yield* journal.prepare(input)
    yield* git(main.workspace, ['replace', input.parent, first.commit])
    expect(yield* journal.recover(first.id)).toEqual(first)
    yield* git(main.workspace, ['symbolic-ref', 'refs/folio/changes/second', 'refs/heads/main'])
    expect(yield* journal.prepare({ ...input, id: 'second' }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    expect((yield* git(main.workspace, ['rev-parse', 'refs/heads/main'])).trim()).toBe(input.parent)
    expect((yield* git(main.workspace, ['symbolic-ref', 'refs/folio/changes/second'])).trim()).toBe('refs/heads/main')
  }).pipe(Effect.provide(layer())))
})

it('rejects extra tree changes and associates Agent commits only with a successful Run of their Task', async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const { input, journal } = yield* setup
    expect(yield* journal.prepare({ ...input, paths: ['wiki/unrelated.md'] }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    const worktrees = yield* TaskWorktrees
    const store = yield* HarnessStore
    const task = yield* worktrees.create({ id: 'task', goal: 'notes', configuration: { agent: 'pi', skillIds: [], integrationIds: [] } })
    yield* store.createSession({ id: 'session', taskId: 'task', agent: 'pi', adapterVersion: '1', purpose: 'task', syncOperationId: null })
    yield* store.bindSession('session', { acpSessionId: 'acp', nativeSessionId: null })
    yield* store.reserveRun({ id: 'run', taskId: 'task', sessionId: 'session', prompt: 'notes', purpose: 'execution',
      resumesRunId: null, baselineCommit: task.baselineCommit })
    yield* Effect.promise(() => writeFile(join(task.path, 'wiki/note.md'), 'agent result'))
    const snapshot = yield* snapshotGitChange({ cwd: task.path, parent: task.baselineCommit, paths: ['wiki/note.md'] })
    const agent: GitChangeIntent = { ...input, id: 'agent', taskId: 'task', runIds: ['run-2', 'run', 'run'], kind: 'wiki', tree: snapshot.tree }
    expect(yield* journal.prepare(agent).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    yield* store.finishRun('run', 'succeeded')
    yield* store.reserveRun({ id: 'run-2', taskId: 'task', sessionId: 'session', prompt: 'more notes', purpose: 'execution',
      resumesRunId: null, baselineCommit: task.baselineCommit })
    yield* store.finishRun('run-2', 'succeeded')
    expect(yield* journal.prepare({ ...agent, kind: 'raws' }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    expect(yield* journal.prepare({ ...agent, runIds: ['other-run'] }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    const prepared = yield* journal.prepare(agent)
    expect(prepared).toMatchObject({ taskId: 'task', runIds: ['run', 'run-2'], kind: 'wiki', state: 'prepared', branch: 'folio/task/task' })
    expect(yield* (yield* makeVaultGit)(task.path, ['show', '-s', '--format=%B', prepared.commit])).toContain(
      'Folio-Run-Id: run\nFolio-Run-Id: run-2\n'
    )
    const sql = yield* SqlClient.SqlClient
    expect(yield* sql`UPDATE git_change_preparations SET tree=${input.tree} WHERE id='agent'`.pipe(Effect.flip)).toBeDefined()
    expect(yield* sql`DELETE FROM git_change_preparations WHERE id='agent'`.pipe(Effect.flip)).toBeDefined()
    expect(yield* sql`UPDATE git_change_preparation_runs SET run_id='other-run' WHERE preparation_id='agent' AND run_id='run'`.pipe(Effect.flip)).toBeDefined()
    expect(yield* sql`DELETE FROM git_change_preparation_runs WHERE preparation_id='agent' AND run_id='run'`.pipe(Effect.flip)).toBeDefined()
  }).pipe(Effect.provide(layer())))
})
