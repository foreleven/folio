import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { NodeServices } from '@effect/platform-node'
import { GitChangeApplications } from '../git/git-change-applications'
import { HarnessStore } from '../harness/harness-store'
import { initializeVaultWorkspace } from '../vault/vault-workspace'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
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
  directory = await realpath(await mkdtemp(join(tmpdir(), 'folio-wiki-')))
  root = join(directory, 'workspace/wiki')
  await mkdir(join(directory, 'entry'))
  await Effect.runPromise(initializeVaultWorkspace(directory, join(directory, 'entry')).pipe(Effect.provide(NodeServices.layer)))
  runtime = ManagedRuntime.make(testLayer())
  service = await runtime.runPromise(WikiService)
})
afterEach(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
const testLayer = () => wikiServiceLayer(directory).pipe(
  Layer.provide(GitChangeApplications.layer(directory)),
  Layer.provide(HarnessStore.layer(directory)),
  Layer.provideMerge(vaultDatabaseLayer(directory)),
  Layer.provide(NodeServices.layer)
)
const create = (id: string, objectType = 'page', parentId: string | null = null) => runtime.runPromise(service.save({
  metadata: { ...newPageMetadata(id, objectType, parentId), title: id }, body: `# ${id}\n\nContent stays on disk.\n`, expectedVersion: null
}))

describe('Wiki file-backed Page service', () => {
  it('saves and reads a Page with a null cover', async () => {
    const page = await runtime.runPromise(service.save({ metadata: { ...newPageMetadata('coverless'), cover: null },
      body: '# No cover\n', expectedVersion: null }))
    expect(page.cover).toBeNull()
    expect((await runtime.runPromise(service.read('coverless'))).cover).toBeNull()
    expect(await readFile(join(root, 'coverless.md'), 'utf8')).toContain('cover: null')
  })

  it('indexes Markdown Page links and reports broken targets', async () => {
    await create('target')
    const source = await runtime.runPromise(service.save({
      metadata: { ...newPageMetadata('source'), title: 'Source' },
      body: '[Target](folio-page:target) and [Missing](folio-page:gone)\n\n`[Code](folio-page:hidden)`',
      expectedVersion: null
    }))
    const rows = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`SELECT source_id AS sourceId, target_id AS targetId FROM links ORDER BY target_id`))
    expect(rows).toEqual([{ sourceId: source.id, targetId: 'gone' }, { sourceId: source.id, targetId: 'target' }])
    const snapshot = await runtime.runPromise(service.snapshot)
    expect(snapshot.issues).toContainEqual({ path: 'source.md', message: 'Folio Page link target is missing: gone' })
  })
  it('projects a Project timeline from reverse links and orders authored offsets by instant', async () => {
    await create('project', 'project')
    const meeting = await runtime.runPromise(service.save({
      metadata: { ...newPageMetadata('meeting', 'meeting'), title: 'Morning meeting',
        properties: { occurredAt: '2026-09-24T09:00:00+08:00' } },
      body: '[Project](folio-page:project)', expectedVersion: null
    }))
    await runtime.runPromise(service.save({
      metadata: { ...newPageMetadata('decision', 'decision'), title: 'Decision',
        properties: { occurredAt: '2026-09-24T02:00:00Z', status: 'accepted' } },
      body: '[Project](folio-page:project)', expectedVersion: null
    }))
    await runtime.runPromise(service.save({
      metadata: { ...newPageMetadata('note', 'note'), title: 'Background' },
      body: '[Project](folio-page:project)', expectedVersion: null
    }))
    expect(await runtime.runPromise(service.projectTimeline('project'))).toEqual([
      { id: 'decision', title: 'Decision', objectType: 'decision', occurredAt: '2026-09-24T02:00:00Z' },
      { id: 'meeting', title: 'Morning meeting', objectType: 'meeting', occurredAt: '2026-09-24T09:00:00+08:00' }
    ])
    await runtime.runPromise(service.save({ metadata: meeting, body: 'No project link', expectedVersion: meeting.version }))
    expect((await runtime.runPromise(service.projectTimeline('project'))).map(entry => entry.id)).toEqual(['decision'])
    await expect(runtime.runPromise(service.projectTimeline('note'))).rejects.toThrow('Project')
  }, 15_000)
  it('reads pinned raw content and a deletion proven by a completed Knowledge Task', async () => {
    const workspace = join(directory, 'workspace')
    const path = 'raws/lark/im/2026-09-24/message.md'
    const rawFile = join(workspace, path)
    const git = async (args: string[]) => (await promisify(execFile)('git', ['-C', workspace, ...args])).stdout.trim()
    await mkdir(join(workspace, 'raws/lark/im/2026-09-24'), { recursive: true })
    await writeFile(rawFile, '# Original evidence\n')
    await git(['add', '--', path])
    await git(['-c', 'user.name=Folio', '-c', 'user.email=folio@localhost', 'commit', '-m', 'Add raw'])
    const fromCommit = await git(['rev-parse', 'HEAD'])
    expect(await runtime.runPromise(service.rawCitation(`folio-raw:${fromCommit}/${path}`))).toMatchObject({
      kind: 'file', content: '# Original evidence\n'
    })
    await rm(rawFile)
    await git(['add', '--', path])
    await git(['-c', 'user.name=Folio', '-c', 'user.email=folio@localhost', 'commit', '-m', 'Remove raw'])
    const toCommit = await git(['rev-parse', 'HEAD'])
    await expect(runtime.runPromise(service.rawCitation(`folio-raw:${toCommit}/${path}`))).rejects.toThrow('missing')
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`INSERT INTO tasks
      (id, type, configuration, state, created_at) VALUES ('knowledge', 'agent',
        ${JSON.stringify({ rawInput: { fromCommit, toCommit } })}, 'completed', 1)`))
    expect(await runtime.runPromise(service.rawCitation(`folio-raw:${toCommit}/${path}#message-1`))).toMatchObject({
      kind: 'deletion', priorContent: '# Original evidence\n', fragment: 'message-1', diff: expect.stringContaining('-# Original evidence')
    })
  }, 15_000)
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
  }, 15_000)

  it('imports nested Markdown and preserves unknown frontmatter on first edit', async () => {
    await mkdir(join(root, 'notes'))
    await writeFile(join(root, 'notes/import.md'), '---\nsource: external\n---\n# Imported\n\nBody')
    await runtime.runPromise(service.refresh)
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

  it('refreshes the index once after canonical Wiki publication', async () => {
    const page = await create('routine')
    await writeFile(join(root, 'routine.md'), (await readFile(join(root, 'routine.md'), 'utf8')).replace('title: routine', 'title: Routine result'))
    expect((await runtime.runPromise(service.snapshot)).pages[0]!.title).toBe('routine')
    await runtime.runPromise(service.refresh)
    expect((await runtime.runPromise(service.snapshot)).pages[0]!.title).toBe('Routine result')
    expect((await runtime.runPromise(service.read(page.id))).version).not.toBe(page.version)
    await rm(join(root, 'routine.md'))
    await runtime.runPromise(service.refresh)
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

  it('accepts only one concurrent save from the same Page version', async () => {
    const page = await create('concurrent')
    const results = await Promise.allSettled([
      runtime.runPromise(service.save({ metadata: page, body: 'first edit', expectedVersion: page.version })),
      runtime.runPromise(service.save({ metadata: page, body: 'second edit', expectedVersion: page.version }))
    ])
    const successes = results.filter(result => result.status === 'fulfilled')
    const failures = results.filter(result => result.status === 'rejected')
    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ reason: expect.objectContaining({ reason: 'invalid-state' }) })
    expect((await runtime.runPromise(service.read(page.id))).body).toBe(successes[0]!.value.body)
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
    expect(JSON.parse(await readFile(join(root, '_types.json'), 'utf8'))).toHaveLength(defaultObjectTypes.length + 1)
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
    await runtime.runPromise(service.refresh)
    const snapshot = await runtime.runPromise(service.snapshot)
    expect(snapshot.pages.map(page => page.id)).toEqual(['good'])
    expect(snapshot.issues).toHaveLength(3)
  })

  it.each(['source: &source { self: *source }', 'source: .inf'])('isolates non-indexable frontmatter: %s', async metadata => {
    await create('good')
    await writeFile(join(root, 'bad.md'), `---\n${metadata}\n---\nBody`)
    await runtime.runPromise(service.refresh)
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
