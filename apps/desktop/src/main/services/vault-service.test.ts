import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner'
import { ConfigProvider, Effect, FileSystem, Layer, ManagedRuntime } from 'effect'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { version } from 'uuid'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigService } from './config-service'
import { VaultService } from './vault-service'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'folio-vault-test-')) })
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

/** Shares an isolated config service so tests can interleave preference and registration writes. */
function makeRuntime(filesystem = NodeFileSystem.layer) {
  return ManagedRuntime.make(VaultService.layer.pipe(
    Layer.provideMerge(ConfigService.layer),
    Layer.provide(NodeChildProcessSpawner.layer),
    Layer.provide(Layer.merge(filesystem, NodePath.layer)),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ FOLIO_CONFIG_DIR: join(root, 'config') })))
  ))
}

/** Creates an existing content directory, including parents, for selection tests. */
async function folder(relative: string): Promise<string> {
  const directory = join(root, relative)
  await mkdir(directory, { recursive: true })
  return directory
}

describe('VaultService', () => {
  it('preserves a file written after the initial empty-directory check', async () => {
    const selected = await folder('wiki')
    const concurrentWriter = Layer.effect(FileSystem.FileSystem, Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      return FileSystem.FileSystem.of({ ...fs, rename: (from, to) =>
        basename(to) === 'workspace'
          ? fs.writeFileString(join(selected, 'late.md'), 'concurrent user edit').pipe(Effect.andThen(fs.rename(from, to)))
          : fs.rename(from, to)
      })
    })).pipe(Layer.provide(NodeFileSystem.layer))
    const runtime = makeRuntime(concurrentWriter)
    try {
      const store = await runtime.runPromise(VaultService)
      expect(await runtime.runPromise(store.register(selected).pipe(Effect.flip))).toMatchObject({ _tag: 'VaultError' })
      expect(await readFile(join(selected, 'late.md'), 'utf8')).toBe('concurrent user edit')
      expect((await lstat(selected)).isDirectory()).toBe(true)
      const config = await runtime.runPromise(ConfigService)
      const vault = (await runtime.runPromise(config.get)).vaults[0]!
      expect(await readFile(join(root, 'config/vaults', vault.id, 'workspace/AGENTS.md'), 'utf8')).toContain('Folio owns Git')
    } finally { await runtime.dispose() }
  })

  it('refuses nonempty selected directories without moving or registering their content', async () => {
    const selected = await folder('existing')
    await writeFile(join(selected, 'keep.md'), 'original')
    const runtime = makeRuntime()
    try {
      const store = await runtime.runPromise(VaultService)
      expect(await runtime.runPromise(store.register(selected).pipe(Effect.flip))).toMatchObject({ message: expect.stringContaining('empty directory') })
      expect(await readFile(join(selected, 'keep.md'), 'utf8')).toBe('original')
      expect((await lstat(selected)).isSymbolicLink()).toBe(false)
      expect((await runtime.runPromise(Effect.flatMap(ConfigService, config => config.get))).vaults).toEqual([])
    } finally { await runtime.dispose() }
  })

  it('initializes only managed files and repairs a missing link without resetting user edits', async () => {
    const selected = await folder('wiki')
    const runtime = makeRuntime()
    try {
      const store = await runtime.runPromise(VaultService)
      const vault = await runtime.runPromise(store.register(selected))
      const workspace = join(root, 'config/vaults', vault.id, 'workspace')
      const git = (args: string[]) => promisify(execFile)('git', ['-C', workspace, ...args]).then(result => result.stdout.trim())
      expect(await git(['branch', '--show-current'])).toBe('main')
      expect((await git(['ls-files'])).split('\n')).toEqual(['.gitignore', 'AGENTS.md'])
      const initial = await git(['rev-parse', 'HEAD'])
      await writeFile(join(workspace, 'AGENTS.md'), 'User instructions')
      await writeFile(join(selected, 'note.md'), 'User content')
      await unlink(selected)
      expect(await runtime.runPromise(store.register(selected))).toEqual(vault)
      expect(await readFile(join(selected, 'note.md'), 'utf8')).toBe('User content')
      expect(await readFile(join(workspace, 'AGENTS.md'), 'utf8')).toBe('User instructions')
      expect(await git(['rev-parse', 'HEAD'])).toBe(initial)
      expect(await runtime.runPromise(store.register(join(workspace, 'wiki')))).toEqual(vault)
    } finally { await runtime.dispose() }
  })

  it('retains the selected directory and retries the same ID after Git is unavailable', async () => {
    const selected = await folder('wiki')
    const runtime = makeRuntime()
    try {
      vi.stubEnv('PATH', join(root, 'no-executables'))
      const store = await runtime.runPromise(VaultService)
      expect(await runtime.runPromise(store.register(selected).pipe(Effect.flip))).toMatchObject({ _tag: 'VaultError' })
      expect((await lstat(selected)).isDirectory()).toBe(true)
      const config = await runtime.runPromise(ConfigService)
      const vault = (await runtime.runPromise(config.get)).vaults[0]!
      vi.unstubAllEnvs()
      // Parent Git context must not redirect initialization into this nonexistent foreign repository.
      vi.stubEnv('GIT_DIR', join(root, 'foreign'))
      vi.stubEnv('GIT_INDEX_FILE', join(root, 'foreign-index'))
      expect(await runtime.runPromise(store.register(selected))).toEqual(vault)
      expect((await lstat(selected)).isSymbolicLink()).toBe(true)
      await expect(lstat(join(root, 'foreign-index'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { vi.unstubAllEnvs(); await runtime.dispose() }
  })

  it('persists a UUID v7 in the global index and keeps settings under its ID across restarts', async () => {
    const selected = await folder('My Wiki')
    const runtime = makeRuntime()
    const vault = await runtime.runPromise(Effect.flatMap(VaultService, (store) => store.register(selected)))
    await runtime.dispose()
    expect(version(vault.id)).toBe(7)
    expect(vault).toMatchObject({ name: 'My Wiki', path: join(await realpath(root), 'My Wiki') })
    expect(await realpath(selected)).toBe(join(await realpath(root), 'config/vaults', vault.id, 'workspace/wiki'))
    expect(JSON.parse(await readFile(join(root, 'config/config.json'), 'utf8'))).toEqual({
      theme: 'system', language: 'system', vaults: [vault], agent: { enabled: false, modelProfiles: [] }
    })
    const settingsFile = join(root, 'config/vaults', vault.id, 'config.json')
    expect(JSON.parse(await readFile(settingsFile, 'utf8'))).toEqual({})
    const databaseFile = join(root, 'config/vaults', vault.id, 'data.db')
    expect((await readFile(databaseFile)).subarray(0, 16).toString()).toBe('SQLite format 3\0')
    expect(await readdir(selected)).toEqual([])
    await writeFile(join(selected, 'note.md'), '# My note')
    expect(await readFile(join(selected, 'note.md'), 'utf8')).toBe('# My note')
    await writeFile(settingsFile, '{"custom":"preserved"}')
    const restarted = makeRuntime()
    try {
      expect(await restarted.runPromise(Effect.flatMap(VaultService, (store) => store.register(selected)))).toEqual(vault)
      expect(await readFile(settingsFile, 'utf8')).toBe('{"custom":"preserved"}')
    } finally { await restarted.dispose() }
  })

  it('deletes the managed vault directory and its published link', async () => {
    const selected = await folder('My Wiki')
    const runtime = makeRuntime()
    try {
      const store = await runtime.runPromise(VaultService)
      const vault = await runtime.runPromise(store.register(selected))
      const managed = join(root, 'config/vaults', vault.id)
      await writeFile(join(selected, 'note.md'), 'content')
      await runtime.runPromise(store.remove(vault))
      await expect(lstat(managed)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(lstat(selected)).rejects.toMatchObject({ code: 'ENOENT' })
      const config = await runtime.runPromise(ConfigService)
      await runtime.runPromise(config.removeVault(vault.id))
      expect((await runtime.runPromise(config.get)).vaults).toEqual([])
    } finally { await runtime.dispose() }
  })

  it('retries removal after the managed tree was deleted but the index still exists', async () => {
    const selected = await folder('retry-removal')
    const runtime = makeRuntime()
    try {
      const store = await runtime.runPromise(VaultService)
      const vault = await runtime.runPromise(store.register(selected))
      await rm(join(root, 'config/vaults', vault.id), { recursive: true })
      await runtime.runPromise(store.remove(vault))
      await runtime.runPromise(store.remove(vault))
      await expect(lstat(selected)).rejects.toMatchObject({ code: 'ENOENT' })
      const config = await runtime.runPromise(ConfigService)
      await runtime.runPromise(config.removeVault(vault.id))
      expect((await runtime.runPromise(config.get)).vaults).toEqual([])
    } finally { await runtime.dispose() }
  })

  it('deduplicates simultaneous selections and symlink aliases', async () => {
    const selected = await folder('wiki')
    const alias = join(root, 'alias')
    await symlink(selected, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const runtime = makeRuntime()
    try {
      const store = await runtime.runPromise(VaultService)
      const values = await runtime.runPromise(Effect.all([
        store.register(selected), store.register(alias), store.register(join(selected, '.'))
      ], { concurrency: 'unbounded' }))
      expect(values[1]).toEqual(values[0])
      expect(values[2]).toEqual(values[0])
      expect(await readdir(join(root, 'config/vaults'))).toEqual([values[0].id])
      const config = await runtime.runPromise(ConfigService)
      expect((await runtime.runPromise(config.get)).vaults).toEqual([values[0]])
    } finally { await runtime.dispose() }
  })

  it('keeps same-name vaults independent without losing concurrent preference updates', async () => {
    const a = await folder('a/wiki')
    const b = await folder('b/wiki')
    const runtime = makeRuntime()
    try {
      const store = await runtime.runPromise(VaultService)
      const config = await runtime.runPromise(ConfigService)
      const [first, second] = await runtime.runPromise(Effect.all([
        store.register(a), store.register(b), config.update({ theme: 'dark' }), config.update({ language: 'en' })
      ], { concurrency: 'unbounded' }))
      expect(first.id).not.toBe(second.id)
      expect(first.name).toBe('wiki')
      expect(second.name).toBe('wiki')
      expect(version(first.id)).toBe(7)
      expect(version(second.id)).toBe(7)
      expect((await readdir(join(root, 'config/vaults'))).sort()).toEqual([first.id, second.id].sort())
      expect(await runtime.runPromise(config.get)).toEqual({
        theme: 'dark', language: 'en', vaults: [first, second], agent: { enabled: false, modelProfiles: [] }
      })
      expect(await runtime.runPromise(store.register(b))).toEqual(second)
    } finally { await runtime.dispose() }
  })

  it('rejects missing paths and regular files without creating configuration', async () => {
    const file = join(root, 'note.md')
    await writeFile(file, 'note')
    const runtime = makeRuntime()
    try {
      const store = await runtime.runPromise(VaultService)
      for (const path of ['', join(root, 'missing'), file]) {
        expect(await runtime.runPromise(Effect.flip(store.register(path)))).toMatchObject({ _tag: 'VaultError' })
      }
      expect(await readdir(root)).toEqual(['note.md'])
    } finally { await runtime.dispose() }
  })

  it.each(['{broken', '{"vaults":null}', '{"vaults":[{"id":"invalid","name":"wiki","path":"/wiki"}]}'])(
    'reports a damaged global index without replacing it: %s', async (json) => {
      const selected = await folder('wiki')
      const configFolder = await folder('config')
      const configFile = join(configFolder, 'config.json')
      await writeFile(configFile, json)
      const runtime = makeRuntime()
      try {
        const store = await runtime.runPromise(VaultService)
        expect(await runtime.runPromise(Effect.flip(store.register(selected)))).toMatchObject({ _tag: 'VaultError' })
        expect(await readFile(configFile, 'utf8')).toBe(json)
        expect(await readdir(configFolder)).toEqual(['config.json'])
      } finally { await runtime.dispose() }
    }
  )

  it('preserves the previous index and cleans temporary files when its commit fails', async () => {
    const selected = await folder('wiki')
    await folder('config')
    const previous = '{"theme":"dark","vaults":[]}'
    await writeFile(join(root, 'config/config.json'), previous)
    const failing = Layer.effect(FileSystem.FileSystem, Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      return FileSystem.FileSystem.of({ ...fs, rename: (_from, to) => fs.rename(join(root, 'missing'), to) })
    })).pipe(Layer.provide(NodeFileSystem.layer))
    const runtime = makeRuntime(failing)
    try {
      const store = await runtime.runPromise(VaultService)
      expect(await runtime.runPromise(Effect.flip(store.register(selected)))).toMatchObject({ _tag: 'VaultError' })
      expect(await readdir(join(root, 'config'))).toEqual(['config.json'])
      expect(await readFile(join(root, 'config/config.json'), 'utf8')).toBe(previous)
    } finally { await runtime.dispose() }
  })

  it('reuses the committed ID when settings initialization fails and is retried', async () => {
    const selected = await folder('wiki')
    const failing = Layer.effect(FileSystem.FileSystem, Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      return FileSystem.FileSystem.of({
        ...fs,
        /** Allows the global index commit but fails only the vault settings file commit. */
        rename: (from, to) => fs.rename(to === join(root, 'config/config.json') ? from : join(root, 'missing'), to)
      })
    })).pipe(Layer.provide(NodeFileSystem.layer))
    const runtime = makeRuntime(failing)
    try {
      const store = await runtime.runPromise(VaultService)
      expect(await runtime.runPromise(Effect.flip(store.register(selected)))).toMatchObject({ _tag: 'VaultError' })
    } finally { await runtime.dispose() }
    const retry = makeRuntime()
    try {
      const config = await retry.runPromise(ConfigService)
      const registered = (await retry.runPromise(config.get)).vaults[0]
      expect(await readdir(join(root, 'config/vaults', registered.id))).toEqual([])
      expect(await retry.runPromise(Effect.flatMap(VaultService, (store) => store.register(selected)))).toEqual(registered)
      expect(JSON.parse(await readFile(join(root, 'config/vaults', registered.id, 'config.json'), 'utf8'))).toEqual({})
    } finally { await retry.dispose() }
  })

  it('creates a missing database for an existing vault without resetting its settings', async () => {
    const selected = await folder('wiki')
    const runtime = makeRuntime()
    try {
      const store = await runtime.runPromise(VaultService)
      const vault = await runtime.runPromise(store.register(selected))
      const directory = join(root, 'config/vaults', vault.id)
      await rm(join(directory, 'data.db'))
      await writeFile(join(directory, 'config.json'), '{"custom":true}')
      expect(await runtime.runPromise(store.register(selected))).toEqual(vault)
      expect((await readFile(join(directory, 'data.db'))).subarray(0, 16).toString()).toBe('SQLite format 3\0')
      expect(await readFile(join(directory, 'config.json'), 'utf8')).toBe('{"custom":true}')
    } finally { await runtime.dispose() }
  })

  it.each(['corrupt file', 'directory'])('reports an unusable database (%s) and retries with the saved ID', async (kind) => {
    const selected = await folder('wiki')
    const runtime = makeRuntime()
    try {
      const store = await runtime.runPromise(VaultService)
      const vault = await runtime.runPromise(store.register(selected))
      const databaseFile = join(root, 'config/vaults', vault.id, 'data.db')
      await rm(databaseFile)
      if (kind === 'directory') await mkdir(databaseFile)
      else await writeFile(databaseFile, 'damaged database')

      expect(await runtime.runPromise(Effect.flip(store.register(selected)))).toMatchObject({ _tag: 'VaultError' })
      if (kind === 'corrupt file') expect(await readFile(databaseFile, 'utf8')).toBe('damaged database')
      const config = await runtime.runPromise(ConfigService)
      expect((await runtime.runPromise(config.get)).vaults).toEqual([vault])

      await rm(databaseFile, { recursive: true })
      expect(await runtime.runPromise(store.register(selected))).toEqual(vault)
      expect((await readFile(databaseFile)).subarray(0, 16).toString()).toBe('SQLite format 3\0')
    } finally { await runtime.dispose() }
  })
})
