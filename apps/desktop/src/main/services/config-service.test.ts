import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import { ConfigProvider, Effect, FileSystem, Layer, ManagedRuntime } from 'effect'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigService } from './config-service'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'folio-config-test-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Builds an isolated store; overrides use ConfigProvider without changing process.env. */
function makeRuntime(
  directory: string | undefined = root,
  filesystem = NodeFileSystem.layer
) {
  return ManagedRuntime.make(ConfigService.layer.pipe(
    Layer.provide(Layer.merge(filesystem, NodePath.layer)),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(
      directory === undefined ? {} : { FOLIO_CONFIG_DIR: directory }
    )))
  ))
}

/** Runs a store consumer and always disposes its runtime, including assertion failures. */
async function withStore<A>(
  consume: (store: ConfigService['Service']) => Promise<A>,
  runtime = makeRuntime()
): Promise<A> {
  try {
    return await consume(await runtime.runPromise(ConfigService))
  } finally {
    await runtime.dispose()
  }
}

describe('ConfigService', () => {
  it('uses ~/.folio when the environment variable is absent or empty', async () => {
    for (const env of [{}, { FOLIO_CONFIG_DIR: '' }]) {
      const runtime = ManagedRuntime.make(ConfigService.layer.pipe(
        Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)))
      ))
      await withStore(async (store) => {
        expect(store.directory).toBe(join(homedir(), '.folio'))
        expect(store.filePath).toBe(join(homedir(), '.folio', 'config.json'))
      }, runtime)
    }
  })

  it('resolves relative overrides from the working directory', async () => {
    await withStore(async (store) => {
      expect(store.directory).toBe(resolve('folio-test-relative'))
    }, makeRuntime('folio-test-relative'))
  })

  it('returns defaults without creating the directory or file', async () => {
    await withStore(async (store) => {
      expect(await Effect.runPromise(store.get)).toEqual({ theme: 'system', language: 'system', vaults: [] })
      expect(await readdir(root)).toEqual([])
    }, makeRuntime(join(root, 'missing')))
  })

  it('creates nested directories and persists a patch across runtimes', async () => {
    const directory = join(root, 'nested', 'config')
    await withStore(async (store) => {
      expect(await Effect.runPromise(store.update({ theme: 'dark' }))).toEqual({
        theme: 'dark', language: 'system', vaults: []
      })
      expect(JSON.parse(await readFile(store.filePath, 'utf8'))).toEqual({
        theme: 'dark', language: 'system', vaults: []
      })
      expect(await readdir(directory)).toEqual(['config.json'])
    }, makeRuntime(directory))
    await withStore(async (store) => {
      expect(await Effect.runPromise(store.get)).toEqual({ theme: 'dark', language: 'system', vaults: [] })
    }, makeRuntime(directory))
  })

  it('defaults missing fields and sees later manual edits', async () => {
    await writeFile(join(root, 'config.json'), '{"theme":"light"}')
    await withStore(async (store) => {
      expect(await Effect.runPromise(store.get)).toEqual({ theme: 'light', language: 'system', vaults: [] })
      await writeFile(store.filePath, '{"language":"zh-CN"}')
      expect(await Effect.runPromise(store.get)).toEqual({ theme: 'system', language: 'zh-CN', vaults: [] })
      expect(await Effect.runPromise(store.update({ theme: 'dark' }))).toEqual({
        theme: 'dark', language: 'zh-CN', vaults: []
      })
    })
  })

  it.each(['{broken', '{"theme":"blue"}', '{"language":"xx"}', '{"theme":null}', '[]', 'null'])(
    'reports invalid stored data without replacing it: %s',
    async (contents) => {
      await writeFile(join(root, 'config.json'), contents)
      await withStore(async (store) => {
        const readError = await Effect.runPromise(Effect.flip(store.get))
        expect(readError).toMatchObject({ _tag: 'ConfigStoreError', operation: 'read', path: store.filePath })
        const writeError = await Effect.runPromise(Effect.flip(store.update({ theme: 'dark' })))
        expect(writeError.operation).toBe('update')
        expect(await readFile(store.filePath, 'utf8')).toBe(contents)
      })
    }
  )

  it('rejects invalid patches at runtime without creating a file', async () => {
    await withStore(async (store) => {
      // Simulate an untyped caller crossing the service boundary.
      for (const patch of [{ theme: 'blue' }, { language: undefined }, { typo: 'dark' }, { vaults: [] }]) {
        const error = await Effect.runPromise(Effect.flip(
          // @ts-expect-error Deliberately invalid input exercises runtime Schema validation.
          store.update(patch)
        ))
        expect(error).toMatchObject({ _tag: 'ConfigStoreError', operation: 'update' })
      }
      expect(await readdir(root)).toEqual([])
    })
  })

  it('serializes concurrent patches without losing either field', async () => {
    await withStore(async (store) => {
      await Effect.runPromise(Effect.all([
        store.update({ theme: 'dark' }),
        store.update({ language: 'en' })
      ], { concurrency: 'unbounded' }))
      expect(await Effect.runPromise(store.get)).toEqual({ theme: 'dark', language: 'en', vaults: [] })
      expect(await readdir(root)).toEqual(['config.json'])
    })
  })

  it('propagates filesystem read errors instead of treating them as absence', async () => {
    await mkdir(join(root, 'config.json'))
    await withStore(async (store) => {
      expect(await Effect.runPromise(Effect.flip(store.get))).toMatchObject({
        _tag: 'ConfigStoreError', operation: 'read', cause: { _tag: 'PlatformError' }
      })
    })
  })

  it('preserves the previous file and cleans temporary data when replacement fails', async () => {
    const contents = '{"theme":"light","language":"en"}'
    await writeFile(join(root, 'config.json'), contents)
    const failingFilesystem = Layer.effect(FileSystem.FileSystem, Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      return FileSystem.FileSystem.of({
        ...fs,
        /** Forces a real platform failure after the temporary file has been written. */
        rename: (_source, destination) => fs.rename(join(root, 'nonexistent'), destination)
      })
    })).pipe(Layer.provide(NodeFileSystem.layer))
    await withStore(async (store) => {
      expect(await Effect.runPromise(Effect.flip(store.update({ theme: 'dark' })))).toMatchObject({
        _tag: 'ConfigStoreError', operation: 'update', cause: { _tag: 'PlatformError' }
      })
      expect(await readFile(store.filePath, 'utf8')).toBe(contents)
      expect(await readdir(root)).toEqual(['config.json'])
    }, makeRuntime(root, failingFilesystem))
  })
})
