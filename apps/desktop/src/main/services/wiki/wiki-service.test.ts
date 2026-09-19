import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { NodeServices } from '@effect/platform-node'
import { GitChangeApplications } from '../git/git-change-applications'
import { GitChangeJournal } from '../git/git-change-journal'
import { HarnessStore } from '../harness/harness-store'
import { initializeVaultWorkspace } from '../vault/vault-workspace'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newPageMetadata, defaultObjectTypes } from '../../../shared/wiki'
import { vaultDatabaseLayer } from '../vault/vault-database'
import { WikiService, wikiServiceLayer } from './wiki-service'

let directory: string
let root: string
let runtime: ManagedRuntime.ManagedRuntime<WikiService | SqlClient.SqlClient, unknown>
let service: WikiService['Service']
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'folio-wiki-'))
  root = join(directory, 'workspace/wiki')
  await mkdir(join(directory, 'entry'))
  await Effect.runPromise(initializeVaultWorkspace(directory, join(directory, 'entry')).pipe(Effect.provide(NodeServices.layer)))
  runtime = ManagedRuntime.make(testLayer())
  service = await runtime.runPromise(WikiService)
})
afterEach(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
const testLayer = () => wikiServiceLayer(directory).pipe(
  Layer.provide(GitChangeApplications.layer(directory)),
  Layer.provide(GitChangeJournal.layer(directory)),
  Layer.provide(HarnessStore.layer),
  Layer.provideMerge(vaultDatabaseLayer(directory)),
  Layer.provide(NodeServices.layer)
)
const create = (id: string, objectType = 'page', parentId: string | null = null) => runtime.runPromise(service.save({
  metadata: { ...newPageMetadata(id, objectType, parentId), title: id }, body: `# ${id}\n\nContent stays on disk.\n`, expectedVersion: null
}))

describe('Wiki file-backed Page service', () => {
  it('persists Markdown and indexes metadata without copying the body into SQLite', async () => {
    const page = await create('one')
    expect(await readFile(join(root, 'one.md'), 'utf8')).toContain('Content stays on disk.')
    const rows = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`SELECT * FROM wiki_pages`))
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain('Content stays on disk.')
    expect(JSON.parse(rows[0]!.metadata as string)).toMatchObject({ id: 'one', title: 'one' })
    await runtime.dispose()
    runtime = ManagedRuntime.make(testLayer())
    service = await runtime.runPromise(WikiService)
    expect(await runtime.runPromise(service.read('one'))).toEqual(page)
  })

  it('commits only editor-owned files so new Task baselines see current Pages and ObjectTypes', async () => {
    await writeFile(join(root, 'unrelated.md'), '# Unrelated draft')
    await create('canonical')
    const git = async (args: string[]) => (await promisify(execFile)('git', ['-C', join(directory, 'workspace'), ...args])).stdout
    expect(await git(['show', 'HEAD:wiki/canonical.md'])).toContain('Content stays on disk.')
    expect(await git(['status', '--porcelain'])).toBe('?? wiki/unrelated.md\n')
    const snapshot = await runtime.runPromise(service.snapshot)
    await runtime.runPromise(service.saveTypes({ objectTypes: [...snapshot.objectTypes, { id: 'book', name: 'Book', icon: '📚', properties: [] }], expectedVersion: snapshot.typesVersion }))
    expect(await git(['show', 'HEAD:wiki/_types.json'])).toContain('Book')
    expect(await git(['status', '--porcelain'])).toBe('?? wiki/unrelated.md\n')
  })

  it('imports nested Markdown and preserves unknown frontmatter on first edit', async () => {
    await mkdir(join(root, 'notes'))
    await writeFile(join(root, 'notes/import.md'), '---\nsource: external\n---\n# Imported\n\nBody')
    const snapshot = await runtime.runPromise(service.snapshot)
    expect(snapshot.pages).toHaveLength(1)
    const page = await runtime.runPromise(service.read(snapshot.pages[0]!.id))
    expect(page.title).toBe('Imported')
    const rows = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`SELECT frontmatter FROM wiki_pages`))
    expect(JSON.parse(rows[0]!.frontmatter as string)).toMatchObject({ source: 'external', title: 'Imported' })
    const saved = await runtime.runPromise(service.save({ metadata: { ...page, title: 'Renamed' }, body: page.body, expectedVersion: page.version }))
    expect(saved.id).toBe(page.id)
    expect(saved.path).toBe('notes/import.md')
    expect(await readFile(join(root, saved.path), 'utf8')).toContain('source: external')
  })

  it('sees externally published Routine Pages and removes stale deleted entries', async () => {
    const page = await create('routine')
    await writeFile(join(root, 'routine.md'), (await readFile(join(root, 'routine.md'), 'utf8')).replace('title: routine', 'title: Routine result'))
    expect((await runtime.runPromise(service.snapshot)).pages[0]!.title).toBe('Routine result')
    expect((await runtime.runPromise(service.read(page.id))).version).not.toBe(page.version)
    await rm(join(root, 'routine.md'))
    expect((await runtime.runPromise(service.snapshot)).pages).toHaveLength(0)
    expect(await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`SELECT * FROM wiki_pages`))).toEqual([])
  })

  it('rejects stale editor writes and never overwrites an invalid file when creating', async () => {
    const page = await create('one')
    const external = `${await readFile(join(root, 'one.md'), 'utf8')}\nExternally changed`
    await writeFile(join(root, 'one.md'), external)
    await expect(runtime.runPromise(service.save({ metadata: page, body: 'stale', expectedVersion: page.version }))).rejects.toThrow('changed')
    expect(await readFile(join(root, 'one.md'), 'utf8')).toBe(external)
    await writeFile(join(root, 'invalid.md'), '---\nbad: [unclosed\n---\n')
    await expect(create('invalid')).rejects.toThrow('changed')
  })

  it('rejects hierarchy cycles, missing parents and invalid typed properties', async () => {
    const parent = await create('parent')
    await create('child', 'page', parent.id)
    await expect(runtime.runPromise(service.save({ metadata: { ...parent, parentId: 'child' }, body: parent.body, expectedVersion: parent.version }))).rejects.toThrow('descendants')
    await expect(create('orphan', 'page', 'missing')).rejects.toThrow('parent')
    await expect(runtime.runPromise(service.save({ metadata: { ...newPageMetadata('project', 'project'), properties: { status: 'arbitrary' } }, body: '', expectedVersion: null }))).rejects.toThrow('Status')
  })

  it('persists type definitions and rejects removal or incompatible changes in use', async () => {
    const initial = await runtime.runPromise(service.snapshot)
    const result = await runtime.runPromise(service.saveTypes({ objectTypes: [...defaultObjectTypes, {
      id: 'book', name: 'Book', icon: '📚', properties: [{ key: 'rating', name: 'Rating', kind: 'number', options: [] }]
    }], expectedVersion: initial.typesVersion }))
    expect(JSON.parse(await readFile(join(root, '_types.json'), 'utf8'))).toHaveLength(6)
    const book = await create('book', 'book')
    await runtime.runPromise(service.save({ metadata: { ...book, properties: { rating: 4 } }, body: book.body, expectedVersion: book.version }))
    await expect(runtime.runPromise(service.saveTypes({ objectTypes: defaultObjectTypes, expectedVersion: result.typesVersion }))).rejects.toThrow('used by Page')
    await expect(runtime.runPromise(service.saveTypes({ objectTypes: result.objectTypes, expectedVersion: '' }))).rejects.toThrow('changed')
  })

  it('reports malformed files and duplicate IDs without hiding healthy pages', async () => {
    await create('good')
    await create('duplicate')
    await writeFile(join(root, 'copy.md'), await readFile(join(root, 'duplicate.md')))
    await writeFile(join(root, 'broken.md'), '---\nnot: [yaml\n---\nBody')
    const snapshot = await runtime.runPromise(service.snapshot)
    expect(snapshot.pages.map(page => page.id)).toEqual(['good'])
    expect(snapshot.issues).toHaveLength(3)
  })

  it.each(['source: &source { self: *source }', 'source: .inf'])('isolates non-indexable frontmatter: %s', async metadata => {
    await create('good')
    await writeFile(join(root, 'bad.md'), `---\n${metadata}\n---\nBody`)
    const snapshot = await runtime.runPromise(service.snapshot)
    expect(snapshot.pages.map(page => page.id)).toEqual(['good'])
    expect(snapshot.issues).toEqual([{ path: 'bad.md', message: expect.stringContaining('JSON-compatible') }])
  })

  it('ignores symlinks and refuses redirected write targets', async () => {
    const outside = join(directory, 'outside.md')
    await writeFile(outside, '# Outside')
    await symlink(outside, join(root, 'outside.md'))
    expect((await runtime.runPromise(service.snapshot)).pages).toHaveLength(0)
    await expect(create('outside')).rejects.toThrow('regular Wiki file')
    expect(await readFile(outside, 'utf8')).toBe('# Outside')
    await expect(create('../escape')).rejects.toThrow('Invalid Page ID')
  })

  it('supports reversible trash and favorites while retaining body and property values', async () => {
    const page = await create('keep')
    const trashed = await runtime.runPromise(service.save({ metadata: { ...page, trashed: true, favorite: true }, body: page.body, expectedVersion: page.version }))
    expect(trashed).toMatchObject({ trashed: true, favorite: true, body: page.body })
    const restored = await runtime.runPromise(service.save({ metadata: { ...trashed, trashed: false }, body: trashed.body, expectedVersion: trashed.version }))
    expect(restored.trashed).toBe(false)
  })
})
