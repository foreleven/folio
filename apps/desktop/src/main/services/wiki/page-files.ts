import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { Schema } from 'effect'
import { parseDocument, stringify } from 'yaml'
import { defaultObjectTypes, newPageMetadata, ObjectType, PageMetadata, type PageDocument } from '../../../shared/wiki'

export type PageFile = PageDocument & { frontmatter: Record<string, unknown> }

export const versionOf = (text: string) => createHash('sha256').update(text).digest('hex')
export const decodeTypes = Schema.decodeUnknownSync(Schema.Array(ObjectType))
const decodeMetadata = Schema.decodeUnknownSync(PageMetadata)
const maximumBytes = 10 * 1024 * 1024

/** Reject redirection at every component, including the Wiki root. Never follow imported symlinks. */
export async function wikiPath(root: string, path: string): Promise<string> {
  if (!path || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..') || path.startsWith('/'))
    throw new Error('Invalid Wiki path')
  if (await realpath(root) !== root) throw new Error('Wiki root was redirected')
  const target = join(root, path)
  const parts = relative(root, dirname(target)).split(sep).filter(Boolean)
  let directory = root
  for (const part of parts) {
    directory = join(directory, part)
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Wiki path was redirected')
  }
  const info = await lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('Expected a regular Wiki file')
  if (info && info.size > maximumBytes) throw new Error('Page exceeds the 10 MiB limit')
  return target
}

/** No database body copy: reads and optimistic versions always come from the Markdown bytes. */
export function parsePage(path: string, source: string, createdAt: string): PageFile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)
  if (source.startsWith('---\n') || source.startsWith('---\r\n')) {
    if (!match) throw new Error('Unclosed YAML frontmatter')
  }
  const document = match ? parseDocument(match[1], { uniqueKeys: true }) : null
  if (document?.errors.length) throw new Error('Invalid YAML frontmatter')
  const raw = document?.toJS({ maxAliasCount: 50 }) ?? {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Frontmatter must be a mapping')
  // YAML aliases may form cycles, and YAML permits non-finite numbers. Reject
  // those per file before indexing so one malformed document cannot break the library.
  try {
    JSON.stringify(raw, (_key, value) => {
      if ((typeof value === 'number' && !Number.isFinite(value)) || typeof value === 'bigint' || value instanceof Map || value instanceof Set)
        throw new Error('Not JSON-compatible')
      return value
    })
  } catch { throw new Error('Frontmatter must contain finite JSON-compatible values without cycles') }
  const body = source.slice(match?.[0].length ?? 0)
  const defaults = newPageMetadata(`file-${versionOf(path).slice(0, 32)}`)
  const metadata = decodeMetadata({ ...defaults,
    title: /^#\s+(.+)$/m.exec(body)?.[1] ?? basename(path, '.md'),
    createdAt, updatedAt: createdAt, ...raw
  })
  if (!Number.isFinite(Date.parse(metadata.createdAt)) || !Number.isFinite(Date.parse(metadata.updatedAt)))
    throw new Error('Page timestamps must be ISO dates')
  return { ...metadata, path, body, version: versionOf(source), frontmatter: { ...raw, ...metadata } }
}

/** Keep unknown frontmatter keys on edits so imports retain their source-specific metadata. */
export function serializePage(metadata: PageMetadata, body: string, previous?: string): string {
  const match = previous && /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(previous)
  const original = match ? parseDocument(match[1]).toJS({ maxAliasCount: 50 }) : {}
  return `---\n${stringify({ ...original, ...decodeMetadata(metadata) })}---\n${body}`
}

export async function readPage(root: string, path: string): Promise<PageFile> {
  const file = await wikiPath(root, path)
  const [source, info] = await Promise.all([readFile(file, 'utf8'), lstat(file)])
  return parsePage(path, source, info.birthtime.toISOString())
}

export async function listMarkdown(root: string): Promise<string[]> {
  if (await realpath(root) !== root) throw new Error('Wiki root was redirected')
  const paths: string[] = []
  async function visit(directory: string) {
    for (const item of await readdir(join(root, directory), { withFileTypes: true })) {
      if (item.isSymbolicLink() || item.name.startsWith('.')) continue
      const path = directory ? `${directory}/${item.name}` : item.name
      if (item.isDirectory()) await visit(path)
      else if (item.isFile() && /\.md$/i.test(path)) paths.push(path)
    }
  }
  await visit('')
  return paths.sort()
}

export async function readObjectTypes(root: string) {
  const path = await wikiPath(root, '_types.json')
  const text = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
  const objectTypes = text === null ? defaultObjectTypes : decodeTypes(JSON.parse(text))
  validateTypes(objectTypes)
  return { objectTypes, typesVersion: text === null ? '' : versionOf(text) }
}

export function validateTypes(types: readonly ObjectType[]): void {
  if (!types.some(type => type.id === 'page')) throw new Error('The Page type is required')
  if (new Set(types.map(type => type.id)).size !== types.length) throw new Error('Duplicate ObjectType ID')
  for (const type of types) {
    if (!/^[a-z][a-z0-9_-]*$/.test(type.id)) throw new Error('Invalid ObjectType ID')
    if (new Set(type.properties.map(field => field.key)).size !== type.properties.length) throw new Error('Duplicate property key')
    for (const field of type.properties) {
      if (!/^[a-z][a-z0-9_-]*$/.test(field.key)) throw new Error('Invalid property key')
      if (new Set(field.options).size !== field.options.length) throw new Error('Duplicate select option')
    }
  }
}

/** Rename publishes complete bytes. The caller holds the shared Git write gate across version checking and publication. */
export async function writeWikiFile(root: string, path: string, content: string): Promise<void> {
  if (Buffer.byteLength(content) > maximumBytes) throw new Error('Page exceeds the 10 MiB limit')
  const target = await wikiPath(root, path)
  const temporary = `${target}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 })
    await rename(temporary, target)
  } finally { await rm(temporary, { force: true }) }
}
