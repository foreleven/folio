import { GitChangeApplications } from '../git/git-change-applications'
import { makeVaultGit } from '../git/vault-git'
import { Effect, Layer } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HarnessStoreError } from '../../../shared/harness'
import { WikiService } from '../../../shared/wiki-service'
import { validatePageProperties, type PageSummary, type ProjectTimelineEntry, type RawCitationView, type SaveObjectTypes, type SavePage, type WikiSnapshot } from '../../../shared/wiki'
import { type PageFile, listMarkdown, parsePage, readObjectTypes, readPage, serializePage, validateTypes, versionOf, wikiPath, writeWikiFile } from './page-files'
import { pageLinkTargets } from './knowledge-links'

export { WikiService } from '../../../shared/wiki-service'
const storage = (error: unknown) => error instanceof HarnessStoreError ? error : new HarnessStoreError({
  reason: 'storage', message: error instanceof Error ? error.message : 'Could not access the Wiki.'
})
const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: storage })
const invalid = (message: string) => new HarnessStoreError({ reason: 'invalid-state', message })
const summary = ({ body: _body, frontmatter: _frontmatter, ...page }: PageFile): PageSummary => page

/** Files are authoritative. Editor mutations reconcile through the main-branch save boundary. */
export function wikiServiceLayer(directory: string) {
  return Layer.effect(WikiService, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const changes = yield* GitChangeApplications
    const git = yield* makeVaultGit
    const main = join(directory, 'workspace')
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
      const linked = pages.flatMap(page => pageLinkTargets(page.body).map(targetId => ({ sourceId: page.id, targetId, path: page.path })))
      const knownIds = new Set(pages.map(page => page.id))
      for (const link of linked) {
        if (!/^[a-zA-Z0-9_-]+$/.test(link.targetId)) issues.push({ path: link.path, message: `Invalid Folio Page link: ${link.targetId}` })
        else if (!knownIds.has(link.targetId)) issues.push({ path: link.path, message: `Folio Page link target is missing: ${link.targetId}` })
      }
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
        yield* sql`DELETE FROM links`
        yield* sql`DELETE FROM wiki_pages`
        yield* sql`DELETE FROM wiki_object_types`
        for (const type of objectTypes) yield* sql`INSERT INTO wiki_object_types (id, definition) VALUES (${type.id}, ${JSON.stringify(type)})`
        for (const page of pages) yield* sql`INSERT INTO wiki_pages (id, path, object_type, parent_id, title, metadata, frontmatter, version)
          VALUES (${page.id}, ${page.path}, ${page.objectType}, ${page.parentId}, ${page.title}, ${JSON.stringify(summary(page))}, ${JSON.stringify(page.frontmatter)}, ${page.version})`
        for (const link of linked.filter(link => /^[a-zA-Z0-9_-]+$/.test(link.targetId)))
          yield* sql`INSERT INTO links (source_id, target_id) VALUES (${link.sourceId}, ${link.targetId})`
      })).pipe(Effect.mapError(storage))
      return { pages: pages.map(summary), objectTypes, typesVersion, issues } satisfies WikiSnapshot
    })
    let indexed = yield* scan()
    const refresh = scan().pipe(Effect.tap(snapshot => Effect.sync(() => { indexed = snapshot })))
    const find = Effect.fn('Wiki.find')(function* (id: string) {
      const page = indexed.pages.find(page => page.id === id)
      if (!page) return yield* new HarnessStoreError({ reason: 'not-found', message: 'Page is missing or has invalid metadata. Refresh the Wiki.' })
      return page
    })
    const read = Effect.fn('Wiki.read')(function* (id: string) {
      const page = yield* find(id)
      return yield* attempt(() => readPage(root, page.path))
    })
    /** Reverse links are indexed from Markdown; sort parsed instants while preserving authored offsets. */
    const projectTimeline = Effect.fn('Wiki.projectTimeline')(function* (id: string) {
      const project = yield* find(id)
      if (project.objectType !== 'project' || project.trashed) return yield* invalid('Choose an active Project Page.')
      const rows = yield* sql<{ sourceId: string }>`SELECT source_id AS sourceId FROM links WHERE target_id=${id}`
      const linked = new Set(rows.map(row => row.sourceId))
      return indexed.pages.filter(page => linked.has(page.id) && !page.trashed &&
        (page.objectType === 'meeting' || page.objectType === 'decision' || page.objectType === 'event') &&
        typeof page.properties.occurredAt === 'string' && Number.isFinite(Date.parse(page.properties.occurredAt)))
        .map(page => ({ id: page.id, title: page.title, objectType: page.objectType as ProjectTimelineEntry['objectType'],
          occurredAt: page.properties.occurredAt as string }))
        .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt) || left.id.localeCompare(right.id))
    }, Effect.mapError(storage))
    /** Resolve the exact canonical raw tree named by a citation, including proven deletions. */
    const rawCitation = Effect.fn('Wiki.rawCitation')(function* (uri: string) {
      const match = /^folio-raw:([a-f0-9]{40}|[a-f0-9]{64})\/(raws\/[^#]+)(?:#([^#]+))?$/.exec(uri)
      const commit = match?.[1]
      const path = match?.[2]
      const fragment = match?.[3] ?? null
      if (!commit || !path || path.split('/').some(part => !part || part === '.' || part === '..') ||
        path.includes('\\') || (fragment !== null && !/^([A-Za-z0-9._~-]|%[A-Fa-f0-9]{2})+$/.test(fragment)))
        return yield* invalid('Invalid raw citation.')
      const canonical = yield* git(main, ['merge-base', '--is-ancestor', commit, 'HEAD']).pipe(
        Effect.as(true), Effect.catch(() => Effect.succeed(false)))
      if (!canonical) return yield* invalid('Raw citation commit is outside canonical history.')
      const atCommit = `${commit}:${path}`
      const exists = yield* git(main, ['cat-file', '-e', atCommit]).pipe(
        Effect.as(true), Effect.catch(() => Effect.succeed(false)))
      let prior: string | null = null
      if (!exists) {
        const candidates = yield* sql<{ fromCommit: string | null }>`SELECT json_extract(configuration, '$.rawInput.fromCommit') AS fromCommit
          FROM tasks WHERE type='agent' AND state='completed'
            AND json_extract(configuration, '$.rawInput.toCommit')=${commit}`
        for (const candidate of candidates) {
          if (!candidate.fromCommit) continue
          const deleted = yield* git(main, ['--literal-pathspecs', 'diff', '--name-only', '--diff-filter=D',
            '--no-renames', candidate.fromCommit, commit, '--', path]).pipe(
            Effect.map(text => text.trim() === path), Effect.catch(() => Effect.succeed(false)))
          if (deleted) { prior = candidate.fromCommit; break }
        }
        if (!prior) return yield* invalid('Raw citation path is missing from its frozen evidence range.')
      }
      const blob = `${prior ?? commit}:${path}`
      const size = Number((yield* git(main, ['cat-file', '-s', blob])).trim())
      const identity = { commit, path, fragment }
      if (!Number.isSafeInteger(size) || size > 1024 * 1024) return { kind: 'too-large', ...identity } satisfies RawCitationView
      const content = yield* git(main, ['show', blob])
      if (!prior) return { kind: 'file', ...identity, content } satisfies RawCitationView
      const diff = yield* git(main, ['--literal-pathspecs', 'diff', '--no-ext-diff', prior, commit, '--', path])
      return { kind: 'deletion', ...identity, priorContent: content, diff } satisfies RawCitationView
    }, Effect.mapError(storage))
    const save = Effect.fn('Wiki.save')(function* (input: SavePage) {
      const snapshot = indexed
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
      yield* refresh
      return yield* attempt(() => readPage(root, path))
    })
    const saveTypes = Effect.fn('Wiki.saveTypes')(function* (input: SaveObjectTypes) {
      const snapshot = indexed
      if (snapshot.typesVersion !== input.expectedVersion) return yield* invalid('ObjectTypes changed. Reload before saving.')
      yield* Effect.try({ try: () => validateTypes(input.objectTypes), catch: error => invalid((error as Error).message) })
      for (const page of snapshot.pages) {
        const type = input.objectTypes.find(type => type.id === page.objectType)
        if (!type) return yield* invalid(`ObjectType is used by Page: ${page.title}`)
        yield* Effect.try({ try: () => validatePageProperties(page, type), catch: error => invalid(`${page.title}: ${(error as Error).message}`) })
      }
      for (const original of snapshot.objectTypes) {
        const next = input.objectTypes.find(type => type.id === original.id)
        if (!next) continue
        for (const property of original.properties) {
          const replacement = next.properties.find(field => field.key === property.key)
          if (replacement && replacement.kind !== property.kind) return yield* invalid(`Property kind cannot change: ${original.name}.${property.name}`)
        }
      }
      yield* attempt(() => writeWikiFile(root, '_types.json', `${JSON.stringify(input.objectTypes, null, 2)}\n`))
      return yield* refresh
    })
    return WikiService.of({
      snapshot: Effect.sync(() => indexed),
      refresh,
      read,
      projectTimeline,
      rawCitation,
      save: input => changes.editWorkspace(save(input).pipe(Effect.map(value => ({ value, paths: [`wiki/${value.path}`] })))),
      saveTypes: input => changes.editWorkspace(saveTypes(input).pipe(Effect.map(value => ({ value, paths: ['wiki/_types.json'] }))))
    })
  }))
}
