import { NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { makeVaultGit } from './vault-git'
import { snapshotGitChange } from './git-change-snapshot'

let root: string
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'folio-snapshot-'))) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
/** Real repository with a baseline and a separate staged draft outside the selected files. */
const setup = Effect.gen(function*() {
  const git = yield* makeVaultGit
  yield* git(root, ['init', '--initial-branch=main', '--template='])
  yield* Effect.promise(async () => {
    await mkdir(join(root, 'wiki'))
    await writeFile(join(root, 'wiki/selected.md'), 'original')
    await writeFile(join(root, 'wiki/draft.md'), 'original draft')
  })
  yield* git(root, ['add', '--', 'wiki/selected.md', 'wiki/draft.md'])
  yield* git(root, ['commit', '-m', 'baseline'])
  return { git, parent: (yield* git(root, ['rev-parse', 'HEAD'])).trim() }
})

it('freezes only selected file bytes and preserves the real index and unselected drafts', async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const { git, parent } = yield* setup
    yield* Effect.promise(async () => {
      await writeFile(join(root, 'wiki/draft.md'), 'staged draft')
      await writeFile(join(root, 'wiki/selected.md'), 'selected version')
      await writeFile(join(root, 'wiki/[draft].md'), 'literal filename')
      await writeFile(join(root, 'wiki/d.md'), 'must not match')
    })
    yield* git(root, ['add', '--', 'wiki/draft.md'])
    const before = yield* Effect.promise(() => readFile(join(root, '.git/index')))
    const snapshot = yield* snapshotGitChange({ cwd: root, parent, paths: ['wiki/selected.md', 'wiki/[draft].md'] })
    expect(snapshot.changed.sort()).toEqual(['wiki/[draft].md', 'wiki/selected.md'])
    expect(yield* git(root, ['show', `${snapshot.tree}:wiki/draft.md`])).toBe('original draft')
    expect(yield* git(root, ['show', `${snapshot.tree}:wiki/selected.md`])).toBe('selected version')
    expect(yield* Effect.promise(() => readFile(join(root, '.git/index')))).toEqual(before)
    yield* Effect.promise(() => writeFile(join(root, 'wiki/selected.md'), 'later user edit'))
    expect(yield* git(root, ['show', `${snapshot.tree}:wiki/selected.md`])).toBe('selected version')
    expect((yield* git(root, ['rev-parse', 'HEAD'])).trim()).toBe(parent)
  }).pipe(Effect.provide(NodeServices.layer)))
})

it('captures deletion and rejects directory, traversal, symlink and stale-parent selections without index writes', async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const { git, parent } = yield* setup
    const before = yield* Effect.promise(() => readFile(join(root, '.git/index')))
    yield* Effect.promise(() => rm(join(root, 'wiki/selected.md')))
    const deleted = yield* snapshotGitChange({ cwd: root, parent, paths: ['wiki/selected.md'] })
    expect(deleted.changed).toEqual(['wiki/selected.md'])
    yield* Effect.promise(() => symlink(root, join(root, 'redirect')))
    for (const path of ['wiki', '../outside', '.git/config', 'redirect/wiki/draft.md']) {
      expect(yield* snapshotGitChange({ cwd: root, parent, paths: [path] }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    }
    expect(yield* Effect.promise(() => readFile(join(root, '.git/index')))).toEqual(before)
    yield* git(root, ['commit', '--allow-empty', '-m', 'new baseline'])
    expect(yield* snapshotGitChange({ cwd: root, parent, paths: ['wiki/draft.md'] }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
  }).pipe(Effect.provide(NodeServices.layer)))
})

it('captures binary and literal pathspec names in a linked Task worktree without changing either index', async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const { git, parent } = yield* setup
    const checkout = join(root, 'task-checkout')
    yield* git(root, ['worktree', 'add', '-b', 'task', checkout, parent])
    const taskIndex = (yield* git(checkout, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim()
    const mainBefore = yield* Effect.promise(() => readFile(join(root, '.git/index')))
    const taskBefore = yield* Effect.promise(() => readFile(taskIndex))
    const path = 'wiki/:binary\nfile.bin'
    yield* Effect.promise(() => writeFile(join(checkout, path), Buffer.from([0, 255, 128, 13, 10, 1])))
    const expectedBlob = (yield* git(checkout, ['hash-object', '--no-filters', '--', path])).trim()
    const snapshot = yield* snapshotGitChange({ cwd: checkout, parent, paths: [path, path] })
    expect(snapshot.paths).toEqual([path])
    expect(snapshot.changed).toEqual([path])
    expect((yield* git(checkout, ['rev-parse', `${snapshot.tree}:${path}`])).trim()).toBe(expectedBlob)
    expect(yield* Effect.promise(() => readFile(taskIndex))).toEqual(taskBefore)
    expect(yield* Effect.promise(() => readFile(join(root, '.git/index')))).toEqual(mainBefore)
    expect((yield* git(checkout, ['rev-parse', 'HEAD'])).trim()).toBe(parent)
  }).pipe(Effect.provide(NodeServices.layer)))
})

it('leaves the checkout and real index intact when staging a missing or ignored selection fails', async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const { git, parent } = yield* setup
    yield* Effect.promise(async () => {
      await writeFile(join(root, '.gitignore'), '*.secret\n')
      await writeFile(join(root, 'wiki/key.secret'), 'local value')
      await writeFile(join(root, 'wiki/selected.md'), 'unsaved edit')
    })
    const before = yield* Effect.promise(() => readFile(join(root, '.git/index')))
    for (const path of ['wiki/missing.md', 'wiki/key.secret']) {
      expect(yield* snapshotGitChange({ cwd: root, parent, paths: ['wiki/selected.md', path] }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
    }
    expect(yield* Effect.promise(() => readFile(join(root, '.git/index')))).toEqual(before)
    expect(yield* Effect.promise(() => readFile(join(root, 'wiki/selected.md'), 'utf8'))).toBe('unsaved edit')
    expect((yield* git(root, ['rev-parse', 'HEAD'])).trim()).toBe(parent)
  }).pipe(Effect.provide(NodeServices.layer)))
})
