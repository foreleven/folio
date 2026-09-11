import { NodeServices } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { WorkspaceChanges } from './workspace-changes'
import { GitChangeApplications } from './git-change-applications'
import { GitChangeJournal } from './git-change-journal'
import { HarnessStore } from './harness-store'
import { vaultDatabaseLayer } from './vault-database'
import { makeVaultGit } from './vault-git'
import { initializeVaultWorkspace } from './vault-workspace'

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'folio-workspace-view-')))
  await mkdir(join(root, 'entry'))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
/** Reopens services over one real Vault; reads use the same production Git/SQL dependencies as saving. */
function layer() {
  return Layer.mergeAll(WorkspaceChanges.layer(root), GitChangeApplications.layer(root)).pipe(
    Layer.provideMerge(GitChangeJournal.layer(root)), Layer.provideMerge(HarnessStore.layer),
    Layer.provideMerge(vaultDatabaseLayer(root)), Layer.provideMerge(NodeServices.layer))
}

it('lists disk changes, ignores staged-only reversions, and previews literal filenames without saving', async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const main = yield* initializeVaultWorkspace(root, join(root, 'entry'))
    const saves = yield* GitChangeApplications
    const view = yield* WorkspaceChanges
    const git = yield* makeVaultGit
    yield* Effect.promise(async () => {
      for (const path of ['note.md', 'deleted.md', 'staged.md']) await writeFile(join(main.wiki, path), 'original\n')
    })
    const saved = yield* saves.save({ id: 'baseline', taskId: null, expectedParent: main.initialCommit,
      paths: ['wiki/note.md', 'wiki/deleted.md', 'wiki/staged.md'] })
    yield* Effect.promise(() => writeFile(join(main.wiki, 'staged.md'), 'staged-only\n'))
    yield* git(main.workspace, ['add', '--', 'wiki/staged.md'])
    yield* Effect.promise(async () => {
      await writeFile(join(main.wiki, 'staged.md'), 'original\n')
      await writeFile(join(main.wiki, 'note.md'), 'modified\n')
      await rm(join(main.wiki, 'deleted.md'))
      await writeFile(join(main.wiki, ':new\n[draft].md'), 'new literal file\n')
      await writeFile(join(main.workspace, '.DS_Store'), 'ignored')
      await symlink(join(root, 'entry'), join(main.wiki, 'redirect'))
    })
    const before = yield* Effect.promise(() => readFile(join(main.workspace, '.git/index')))
    const result = yield* view.inspect
    expect(result.registered).toBe(true)
    expect(result.files).toEqual(expect.arrayContaining([
      { path: 'wiki/note.md', status: 'modified', selectable: true },
      { path: 'wiki/deleted.md', status: 'deleted', selectable: true },
      { path: 'wiki/:new\n[draft].md', status: 'added', selectable: true },
      { path: 'wiki/redirect', status: 'added', selectable: false }
    ]))
    expect(result.files.some(file => file.path === 'wiki/staged.md' || file.path === '.DS_Store')).toBe(false)
    expect(result.pending).toEqual([])
    yield* git(main.workspace, ['config', 'diff.external', 'false'])
    const preview = yield* view.diff({ expectedParent: saved.commit, path: 'wiki/:new\n[draft].md', saveId: null })
    expect(preview).toMatchObject({ kind: 'text' })
    expect(preview.text).toContain('+new literal file')
    expect(yield* view.diff({ expectedParent: saved.commit, path: 'wiki/redirect/outside.md', saveId: null }).pipe(Effect.flip))
      .toMatchObject({ reason: 'invalid-state' })
    expect(yield* Effect.promise(() => readFile(join(main.workspace, '.git/index')))).toEqual(before)
    expect((yield* git(main.workspace, ['rev-parse', 'HEAD'])).trim()).toBe(saved.commit)
    expect((yield* view.inspect).pending).toEqual([])
  }).pipe(Effect.provide(layer())))
}, 15_000)

it('discovers accepted saves without application intent after restart and previews the original content', async () => {
  const parent = await Effect.runPromise(Effect.gen(function*() {
    const main = yield* initializeVaultWorkspace(root, join(root, 'entry'))
    yield* Effect.promise(() => writeFile(join(main.wiki, 'note.md'), 'accepted content\n'))
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TRIGGER fail_application BEFORE INSERT ON git_change_applications
      BEGIN SELECT RAISE(ABORT, 'fixture lost application intent'); END`
    const saves = yield* GitChangeApplications
    yield* saves.save({ id: 'pending', taskId: null, expectedParent: main.initialCommit, paths: ['wiki/note.md'] }).pipe(Effect.flip)
    yield* sql`DROP TRIGGER fail_application`
    return main.initialCommit
  }).pipe(Effect.provide(layer())))
  await writeFile(join(root, 'workspace/wiki/note.md'), 'newer content\n')
  await Effect.runPromise(Effect.gen(function*() {
    const view = yield* WorkspaceChanges
    const result = yield* view.inspect
    expect(result.pending).toEqual([{ id: 'pending', expectedParent: parent, paths: ['wiki/note.md'], state: 'prepared' }])
    const original = yield* view.diff({ expectedParent: parent, path: 'wiki/note.md', saveId: 'pending' })
    expect(original.text).toContain('+accepted content')
    expect(original.text).not.toContain('+newer content')
    const live = yield* view.diff({ expectedParent: parent, path: 'wiki/note.md', saveId: null })
    expect(live.text).toContain('+newer content')
    expect(yield* view.diff({ expectedParent: parent, path: 'AGENTS.md', saveId: 'pending' }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    expect((yield* view.inspect).pending).toEqual(result.pending)
  }).pipe(Effect.provide(layer())))
})

it('bounds previews, identifies binary changes, and rejects an obsolete live baseline', async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const main = yield* initializeVaultWorkspace(root, join(root, 'entry'))
    const view = yield* WorkspaceChanges
    const git = yield* makeVaultGit
    yield* Effect.promise(async () => {
      await writeFile(join(main.wiki, 'large.md'), 'x'.repeat(128 * 1024 + 1))
      await writeFile(join(main.wiki, 'binary.dat'), Buffer.from([0, 255, 4, 0]))
    })
    expect(yield* view.diff({ expectedParent: main.initialCommit, path: 'wiki/large.md', saveId: null })).toEqual({ kind: 'too-large', text: '' })
    expect(yield* view.diff({ expectedParent: main.initialCommit, path: 'wiki/binary.dat', saveId: null })).toMatchObject({ kind: 'binary' })
    yield* git(main.workspace, ['commit', '--allow-empty', '-m', 'external commit'])
    expect((yield* view.inspect).registered).toBe(false)
    expect(yield* view.diff({ expectedParent: main.initialCommit, path: 'wiki/binary.dat', saveId: null }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
  }).pipe(Effect.provide(layer())))
})
