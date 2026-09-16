import { NodeServices } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HarnessStore } from './harness-store'
import { initializeVaultWorkspace } from './vault-workspace'
import { TaskWorktrees } from './task-worktrees'
import { makeVaultGit } from './vault-git'
import { vaultDatabaseLayer } from './vault-database'

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'folio-worktrees-')))
  await mkdir(join(root, 'entry'))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
/** Every test uses real Git and a scoped Vault database; reopening shares only durable state. */
function layer() {
  return TaskWorktrees.layer(root).pipe(Layer.provideMerge(HarnessStore.layer),
    Layer.provideMerge(vaultDatabaseLayer(root)), Layer.provideMerge(NodeServices.layer))
}
const draft = (id: string) => ({ id, goal: 'Edit notes', configuration: { agent: 'pi' as const, skillIds: [], integrationIds: [] } })
const initialize = Effect.suspend(() => initializeVaultWorkspace(root, join(root, 'entry')))

describe('Task Git worktree creation checkpoints', () => {
  it('creates isolated Task branches from registered main while preserving unsaved user and Task edits', async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const main = yield* initialize
      yield* Effect.promise(() => writeFile(join(main.wiki, 'unsaved.md'), 'user draft'))
      const worktrees = yield* TaskWorktrees
      const first = yield* worktrees.create(draft('first'))
      const second = yield* worktrees.create(draft('second'))
      expect(first.baselineCommit).toBe(main.initialCommit)
      const git = yield* makeVaultGit
      expect((yield* git(first.path, ['branch', '--show-current'])).trim()).toBe('folio/task/first')
      yield* Effect.promise(() => expect(readFile(join(first.path, 'wiki/unsaved.md'))).rejects.toMatchObject({ code: 'ENOENT' }))
      yield* Effect.promise(() => writeFile(join(first.path, 'wiki/task.md'), 'task edit'))
      expect(yield* worktrees.ensure('first')).toEqual(first)
      yield* Effect.promise(() => expect(readFile(join(second.path, 'wiki/task.md'))).rejects.toMatchObject({ code: 'ENOENT' }))
      expect(yield* Effect.promise(() => readFile(join(main.wiki, 'unsaved.md'), 'utf8'))).toBe('user draft')
      expect(yield* Effect.promise(() => readFile(join(first.path, 'wiki/task.md'), 'utf8'))).toBe('task edit')
    }).pipe(Effect.provide(layer())))
  })

  it.each([false, true])('recovers a successful Git add after database failure, preserving edits=%s', async changed => {
    let path = ''
    await Effect.runPromise(Effect.gen(function*() {
      yield* initialize
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TRIGGER fail_ready BEFORE UPDATE OF worktree_state ON tasks WHEN NEW.worktree_state='ready'
        BEGIN SELECT RAISE(ABORT, 'fixture database failure'); END`
      const worktrees = yield* TaskWorktrees
      expect(yield* worktrees.create(draft('interrupted')).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
      const store = yield* HarnessStore
      const task = yield* store.task('interrupted')
      expect(task.worktreeState).toBe('creating')
      path = task.worktree
      expect(yield* Effect.promise(() => readFile(join(path, '.git'), 'utf8'))).toContain('gitdir:')
      yield* sql`DROP TRIGGER fail_ready`
    }).pipe(Effect.provide(layer())))
    if (changed) await writeFile(join(path, 'keep.md'), 'uncommitted progress')
    await Effect.runPromise(Effect.gen(function*() {
      const worktrees = yield* TaskWorktrees
      const store = yield* HarnessStore
      if (changed) {
        expect(yield* worktrees.ensure('interrupted').pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
        expect((yield* store.task('interrupted')).worktreeState).toBe('creating')
        expect(yield* Effect.promise(() => readFile(join(path, 'keep.md'), 'utf8'))).toBe('uncommitted progress')
      } else {
        expect((yield* worktrees.ensure('interrupted')).path).toBe(path)
        expect((yield* store.task('interrupted')).worktreeState).toBe('ready')
        const git = yield* makeVaultGit
        expect((yield* git(path, ['rev-list', '--count', 'HEAD'])).trim()).toBe('1')
      }
    }).pipe(Effect.provide(layer())))
  })

  it('allows Session metadata before resources but blocks Runs until ready and refuses resource work during an active Run', async () => {
    await Effect.runPromise(Effect.gen(function*() {
      yield* initialize
      const store = yield* HarnessStore
      yield* store.createTask({ ...draft('task'), branch: 'folio/task/task', worktree: join(root, 'worktrees/task') })
      const session = { id: 'session', taskId: 'task', agent: 'pi' as const, adapterVersion: '1', purpose: 'task' as const, syncOperationId: null }
      yield* store.createSession(session)
      expect(yield* store.sessions('task')).toMatchObject([{ id: 'session', acpSessionId: null }])
      const worktrees = yield* TaskWorktrees
      const checkout = yield* worktrees.ensure('task')
      yield* store.bindSession('session', { acpSessionId: 'acp', nativeSessionId: null })
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE tasks SET worktree_state='creating' WHERE id='task'`
      expect(yield* store.reserveRun({ id: 'blocked', taskId: 'task', sessionId: 'session', prompt: 'notes', purpose: 'execution', resumesRunId: null, baselineCommit: checkout.baselineCommit }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      yield* sql`UPDATE tasks SET worktree_state='ready' WHERE id='task'`
      yield* store.reserveRun({ id: 'run', taskId: 'task', sessionId: 'session', prompt: 'notes', purpose: 'execution', resumesRunId: null, baselineCommit: checkout.baselineCommit })
      expect(yield* worktrees.ensure('task').pipe(Effect.flip)).toMatchObject({ reason: 'task-busy' })
    }).pipe(Effect.provide(layer())))
  })

  it('refuses unregistered main commits and mismatched Task paths without overwriting them', async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const main = yield* initialize
      const git = yield* makeVaultGit
      yield* Effect.promise(() => writeFile(join(main.wiki, 'external.md'), 'external commit'))
      yield* git(main.workspace, ['add', '--', 'wiki/external.md'])
      yield* git(main.workspace, ['commit', '-m', 'External change'])
      const worktrees = yield* TaskWorktrees
      expect(yield* worktrees.create(draft('unknown-base')).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      expect((yield* git(main.workspace, ['for-each-ref', '--format=%(refname)', 'refs/heads/folio/task/unknown-base'])).trim()).toBe('')
      const store = yield* HarnessStore
      yield* store.createTask({ ...draft('wrong-path'), branch: 'folio/task/wrong-path', worktree: main.workspace })
      expect(yield* worktrees.ensure('wrong-path').pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      expect(yield* Effect.promise(() => readFile(join(main.wiki, 'external.md'), 'utf8'))).toBe('external commit')
    }).pipe(Effect.provide(layer())))
  })

  it('releases a clean explicitly completed Task only after successful Run synchronization is settled', async () => {
    await Effect.runPromise(Effect.gen(function*() {
      yield* initialize
      const worktrees = yield* TaskWorktrees
      const checkout = yield* worktrees.create(draft('completed'))
      const store = yield* HarnessStore
      yield* store.createSession({ id: 'completed-session', taskId: 'completed', agent: 'pi', adapterVersion: '1', purpose: 'task', syncOperationId: null })
      yield* store.bindSession('completed-session', { acpSessionId: 'completed-acp', nativeSessionId: null })
      yield* store.reserveRun({ id: 'completed-run', taskId: 'completed', sessionId: 'completed-session', prompt: 'finish', purpose: 'execution',
        resumesRunId: null, baselineCommit: checkout.baselineCommit })
      yield* store.finishRun('completed-run', 'succeeded')
      expect(yield* worktrees.complete('completed').pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE runs SET sync_state='not-required' WHERE id='completed-run'`
      yield* Effect.promise(() => writeFile(join(checkout.path, 'wiki/draft.md'), 'keep me'))
      expect(yield* worktrees.complete('completed').pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      expect(yield* Effect.promise(() => readFile(join(checkout.path, 'wiki/draft.md'), 'utf8'))).toBe('keep me')
      yield* Effect.promise(() => rm(join(checkout.path, 'wiki/draft.md')))

      const completed = yield* worktrees.complete('completed')
      expect(completed).toMatchObject({ id: 'completed', state: 'completed', worktreeState: 'released' })
      expect(yield* worktrees.complete('completed')).toEqual(completed)
      expect(yield* worktrees.ensure('completed').pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      expect(yield* Effect.promise(() => readFile(join(checkout.path, '.git')).then(() => 'exists', (error: NodeJS.ErrnoException) => error.code))).toBe('ENOENT')
      const git = yield* makeVaultGit
      expect((yield* git(join(root, 'workspace'), ['rev-parse', 'refs/heads/folio/task/completed'])).trim()).toBe(checkout.baselineCommit)
      expect(yield* store.sessions('completed')).toHaveLength(1)
      expect(yield* store.runs('completed')).toHaveLength(1)
      yield* git(join(root, 'workspace'), ['branch', '-D', 'folio/task/completed'])
      expect(yield* worktrees.complete('completed').pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    }).pipe(Effect.provide(layer())))
  })

  it('reopens a released Task from current main while retaining its prior branch head', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const main = yield* initialize
      const worktrees = yield* TaskWorktrees
      const checkout = yield* worktrees.create(draft('reopen'))
      const git = yield* makeVaultGit
      const oldHead = (yield* git(checkout.path, ['rev-parse', 'HEAD'])).trim()
      yield* worktrees.complete('reopen')

      const mainHead = (yield* git(main.workspace, ['rev-parse', 'HEAD'])).trim()

      const reopened = yield* worktrees.reopen('reopen')
      expect(reopened).toMatchObject({ path: checkout.path, branch: 'folio/task/reopen', baselineCommit: mainHead })
      expect((yield* git(reopened.path, ['rev-parse', 'HEAD'])).trim()).toBe(mainHead)
      expect((yield* git(main.workspace, ['rev-parse', 'refs/heads/folio/task/reopen'])).trim()).toBe(mainHead)
      expect((yield* git(main.workspace, ['rev-parse', `refs/folio/task/reopen/reopen/${mainHead}`])).trim()).toBe(oldHead)
      expect(yield* (yield* HarnessStore).task('reopen')).toMatchObject({ state: 'active', worktreeState: 'ready', worktreeBase: mainHead })
    }).pipe(Effect.provide(layer())))
  })

  it('retries a branch promotion after its SQLite reopen receipt fails', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const main = yield* initialize
      const worktrees = yield* TaskWorktrees
      const checkout = yield* worktrees.create(draft('reopen-retry'))
      const git = yield* makeVaultGit
      const oldHead = (yield* git(checkout.path, ['rev-parse', 'HEAD'])).trim()
      yield* worktrees.complete('reopen-retry')
      const mainHead = (yield* git(main.workspace, ['rev-parse', 'HEAD'])).trim()
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TRIGGER fail_reopen BEFORE UPDATE OF state ON tasks
        WHEN NEW.state='active' BEGIN SELECT RAISE(ABORT, 'fixture reopen receipt'); END`

      expect(yield* worktrees.reopen('reopen-retry').pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
      expect((yield* git(main.workspace, ['rev-parse', 'refs/heads/folio/task/reopen-retry'])).trim()).toBe(mainHead)
      expect((yield* git(main.workspace, ['rev-parse', `refs/folio/task/reopen-retry/reopen/${mainHead}`])).trim()).toBe(oldHead)
      expect(yield* (yield* HarnessStore).task('reopen-retry')).toMatchObject({ state: 'completed', worktreeState: 'released' })

      yield* sql`DROP TRIGGER fail_reopen`
      const reopened = yield* worktrees.reopen('reopen-retry')
      expect(reopened.baselineCommit).toBe(mainHead)
      expect((yield* git(reopened.path, ['rev-parse', 'HEAD'])).trim()).toBe(mainHead)
    }).pipe(Effect.provide(layer())))
  })

  it('recovers worktree release after Git succeeds but its database receipt fails', async () => {
    await Effect.runPromise(Effect.gen(function*() {
      yield* initialize
      const worktrees = yield* TaskWorktrees
      const checkout = yield* worktrees.create(draft('release-receipt'))
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TRIGGER fail_release_receipt BEFORE UPDATE OF worktree_state ON tasks
        WHEN NEW.worktree_state='released' BEGIN SELECT RAISE(ABORT, 'fixture'); END`
      expect(yield* worktrees.complete('release-receipt').pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
      expect(yield* Effect.promise(() => readFile(join(checkout.path, '.git')).then(() => 'exists', (error: NodeJS.ErrnoException) => error.code))).toBe('ENOENT')
      expect(yield* (yield* HarnessStore).task('release-receipt')).toMatchObject({ state: 'completed', worktreeState: 'releasing' })
      yield* sql`DROP TRIGGER fail_release_receipt`
    }).pipe(Effect.provide(layer())))

    await Effect.runPromise(Effect.gen(function*() {
      const worktrees = yield* TaskWorktrees
      expect(yield* worktrees.complete('release-receipt')).toMatchObject({ state: 'completed', worktreeState: 'released' })
    }).pipe(Effect.provide(layer())))
  })

  it('does not release a clean Task commit created after the durable release checkpoint', async () => {
    await Effect.runPromise(Effect.gen(function*() {
      yield* initialize
      const worktrees = yield* TaskWorktrees
      const checkout = yield* worktrees.create(draft('changed-during-release'))
      const sql = yield* SqlClient.SqlClient
      // Simulate a crash after completion intent was recorded but before Git removed the checkout.
      yield* sql`UPDATE tasks SET state='completed', worktree_state='releasing' WHERE id='changed-during-release'`
      yield* Effect.promise(() => writeFile(join(checkout.path, 'wiki/external.md'), 'external commit'))
      const git = yield* makeVaultGit
      yield* git(checkout.path, ['add', '--', 'wiki/external.md'])
      yield* git(checkout.path, ['commit', '-m', 'External commit during release'])

      expect(yield* worktrees.complete('changed-during-release').pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      expect(yield* Effect.promise(() => readFile(join(checkout.path, 'wiki/external.md'), 'utf8'))).toBe('external commit')
      expect(yield* (yield* HarnessStore).task('changed-during-release')).toMatchObject({ state: 'completed', worktreeState: 'releasing' })
    }).pipe(Effect.provide(layer())))
  })

  it('does not publish a lost release receipt after the retained Task branch is removed', async () => {
    await Effect.runPromise(Effect.gen(function*() {
      yield* initialize
      const worktrees = yield* TaskWorktrees
      const checkout = yield* worktrees.create(draft('missing-release-branch'))
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TRIGGER fail_release_receipt BEFORE UPDATE OF worktree_state ON tasks
        WHEN NEW.worktree_state='released' BEGIN SELECT RAISE(ABORT, 'fixture'); END`
      expect(yield* worktrees.complete('missing-release-branch').pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
      yield* sql`DROP TRIGGER fail_release_receipt`
      const git = yield* makeVaultGit
      yield* git(join(root, 'workspace'), ['branch', '-D', 'folio/task/missing-release-branch'])

      expect(yield* worktrees.complete('missing-release-branch').pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
      expect(yield* Effect.promise(() => readFile(join(checkout.path, '.git')).then(() => 'exists', (error: NodeJS.ErrnoException) => error.code))).toBe('ENOENT')
      expect(yield* (yield* HarnessStore).task('missing-release-branch')).toMatchObject({ state: 'completed', worktreeState: 'releasing' })
    }).pipe(Effect.provide(layer())))
  })
})
