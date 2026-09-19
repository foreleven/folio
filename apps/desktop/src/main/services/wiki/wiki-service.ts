import { GitChangeApplications } from '../git/git-change-applications'
import { Effect, Layer } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HarnessStoreError } from '../../../shared/harness'
import { WikiService } from '../../../shared/wiki-service'
import { validatePageProperties, type PageSummary, type SaveObjectTypes, type SavePage, type WikiSnapshot } from '../../../shared/wiki'
import { VaultGitWriteLock } from '../git/vault-git-write-lock'
import { type PageFile, listMarkdown, parsePage, readObjectTypes, readPage, serializePage, validateTypes, versionOf, wikiPath, writeWikiFile } from './page-files'

export { WikiService } from '../../../shared/wiki-service'
const storage = (error: unknown) => error instanceof HarnessStoreError ? error : new HarnessStoreError({
  reason: 'storage', message: error instanceof Error ? error.message : 'Could not access the Wiki.'
})
const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: storage })
const invalid = (message: string) => new HarnessStoreError({ reason: 'invalid-state', message })
const summary = ({ body: _body, frontmatter: _frontmatter, ...page }: PageFile): PageSummary => page

/** Files are authoritative. Reconcile under the same gate used by Task publication and user saves. */
export function wikiServiceLayer(directory: string) {
  return Layer.effect(WikiService, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const gate = yield* VaultGitWriteLock
    const changes = yield* GitChangeApplications
    const root = join(directory, 'workspace', 'wiki')
    const scan = Effect.fn('Wiki.scan')(function* () {
      const { objectTypes, typesVersion } = yield* attempt(() => readObjectTypes(root))
      const paths = yield* attempt(() => listMarkdown(root))
      const documents: PageFile[] = []
      const issues: { path: string; message: string }[] = []
      for (const path of paths) {
        const result = yield* attempt(() => readPage(root, path)).pipe(Effect.result)
        if (result._tag === 'Failure') issues.push({ path, message: result.failure.message })
        else documents.push(result.success)
      }
      const counts = new Map<string, number>()
      for (const page of documents) counts.set(page.id, (counts.get(page.id) ?? 0) + 1)
      const pages = documents.filter(page => {
        if (counts.get(page.id) === 1) return true
        issues.push({ path: page.path, message: 'Duplicate Page ID; give each file a unique id.' })
        return false
      })
      for (const page of pages) {
        const type = objectTypes.find(type => type.id === page.objectType)
        if (!type) issues.push({ path: page.path, message: `Unknown ObjectType: ${page.objectType}` })
        else {
          try { validatePageProperties(page, type) }
          catch (error) { issues.push({ path: page.path, message: (error as Error).message }) }
        }
        const seen = new Set([page.id])
        let parentId = page.parentId
        while (parentId) {
          const parent = pages.find(candidate => candidate.id === parentId)
          if (!parent || seen.has(parentId)) {
            issues.push({ path: page.path, message: parent ? 'Page hierarchy contains a cycle.' : 'Parent Page is missing.' })
            break
          }
          seen.add(parentId); parentId = parent.parentId
        }
      }
      // Index replacement is atomic. Invalid/deleted files cannot leave stale readable rows.
      yield* sql.withTransaction(Effect.gen(function* () {
        yield* sql`DELETE FROM wiki_pages`
        yield* sql`DELETE FROM wiki_object_types`
        for (const type of objectTypes) yield* sql`INSERT INTO wiki_object_types (id, definition) VALUES (${type.id}, ${JSON.stringify(type)})`
        for (const page of pages) yield* sql`INSERT INTO wiki_pages (id, path, object_type, parent_id, title, metadata, frontmatter, version)
          VALUES (${page.id}, ${page.path}, ${page.objectType}, ${page.parentId}, ${page.title}, ${JSON.stringify(summary(page))}, ${JSON.stringify(page.frontmatter)}, ${page.version})`
      })).pipe(Effect.mapError(storage))
      return { pages: pages.map(summary), objectTypes, typesVersion, issues } satisfies WikiSnapshot
    })
    const find = Effect.fn('Wiki.find')(function* (id: string) {
      const snapshot = yield* scan()
      const page = snapshot.pages.find(page => page.id === id)
      if (!page) return yield* new HarnessStoreError({ reason: 'not-found', message: 'Page is missing or has invalid metadata. Refresh the Wiki.' })
      return page
    })
    const read = Effect.fn('Wiki.read')(function* (id: string) {
      const page = yield* find(id)
      return yield* attempt(() => readPage(root, page.path))
    })
    const save = Effect.fn('Wiki.save')(function* (input: SavePage) {
      const snapshot = yield* scan()
      const metadata = input.metadata
      const current = snapshot.pages.find(page => page.id === metadata.id)
      if (input.expectedVersion === null ? current !== undefined : !current || current.version !== input.expectedVersion)
        return yield* invalid('This Page changed since it was opened. Reload before saving.')
      if (!/^[a-zA-Z0-9_-]+$/.test(metadata.id)) return yield* invalid('Invalid Page ID')
      const type = snapshot.objectTypes.find(type => type.id === metadata.objectType)
      if (!type) return yield* invalid('Choose an existing ObjectType.')
      yield* Effect.try({ try: () => validatePageProperties(metadata, type), catch: error => invalid((error as Error).message) })
      const seen = new Set([metadata.id])
      let parentId = metadata.parentId
      while (parentId) {
        if (seen.has(parentId)) return yield* invalid('A Page cannot be placed inside itself or its descendants.')
        seen.add(parentId)
        const parent = snapshot.pages.find(page => page.id === parentId)
        if (!parent || (!metadata.trashed && parent.trashed)) return yield* invalid('Choose an existing Page outside trash as the parent.')
        parentId = parent.parentId
      }
      for (const field of type.properties.filter(field => field.kind === 'relation')) {
        const ids = metadata.properties[field.key]
        if (Array.isArray(ids) && ids.some(id => !snapshot.pages.some(page => page.id === id)))
          return yield* invalid(`A related Page in ${field.name} is missing.`)
      }
      const path = current?.path ?? `${metadata.id}.md`
      const previous = yield* attempt(async () => {
        const file = await wikiPath(root, path)
        return readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
      })
      // A file can exist but be excluded from the index (e.g. invalid YAML). Never overwrite it as a new Page.
      if (previous === undefined ? input.expectedVersion !== null : versionOf(previous) !== input.expectedVersion)
        return yield* invalid('The Markdown file changed. Reload before saving.')
      const next = { ...metadata, createdAt: current?.createdAt ?? metadata.createdAt, updatedAt: new Date().toISOString() }
      const content = serializePage(next, input.body, previous)
      yield* Effect.try({ try: () => parsePage(path, content, next.createdAt), catch: storage })
      yield* attempt(() => writeWikiFile(root, path, content))
      yield* scan()
      return yield* attempt(() => readPage(root, path))
    })
    const saveTypes = Effect.fn('Wiki.saveTypes')(function* (input: SaveObjectTypes) {
      const snapshot = yield* scan()
      if (snapshot.typesVersion !== input.expectedVersion) return yield* invalid('ObjectTypes changed. Reload before saving.')
      yield* Effect.try({ try: () => validateTypes(input.objectTypes), catch: error => invalid((error as Error).message) })
      for (const page of snapshot.pages) {
        const type = input.objectTypes.find(type => type.id === page.objectType)
        if (!type) return yield* invalid(`ObjectType is used by Page: ${page.title}`)
        yield* Effect.try({ try: () => validatePageProperties(page, type), catch: error => invalid(`${page.title}: ${(error as Error).message}`) })
      }
      yield* attempt(() => writeWikiFile(root, '_types.json', `${JSON.stringify(input.objectTypes, null, 2)}\n`))
      return yield* scan()
    })
    return WikiService.of({
      snapshot: gate.withLock(scan()),
      read: id => gate.withLock(read(id)),
      save: input => changes.editWorkspace(save(input).pipe(Effect.map(value => ({ value, paths: [`wiki/${value.path}`] })))),
      saveTypes: input => changes.editWorkspace(saveTypes(input).pipe(Effect.map(value => ({ value, paths: ['wiki/_types.json'] }))))
    })
  })).pipe(Layer.provide(VaultGitWriteLock.layer(directory)))
}
