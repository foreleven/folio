import { Context, Effect, Layer, Schema } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { HarnessStoreError, type TaskRecord } from '../../shared/harness'
import { ConfigService } from './config-service'
import { IntegrationService, type PreparedIntegrationResources } from './integration-service'

const RelativePath = Schema.NonEmptyString.check(Schema.makeFilter(path => !isAbsolute(path)
  && path.split(/[\\/]/).every(part => part !== '..' && part !== '.' && part.length > 0)))
const TaskId = Schema.NonEmptyString.check(Schema.makeFilter(id => /^[a-zA-Z0-9_-]{1,128}$/.test(id)))
const Manifest = Schema.Struct({
  version: Schema.Literal(1), taskId: Schema.NonEmptyString,
  integrationIds: Schema.Array(Schema.NonEmptyString),
  skillPaths: Schema.Array(RelativePath), executableDirectories: Schema.Array(RelativePath),
  entries: Schema.Array(Schema.Struct({ path: RelativePath, directory: Schema.Boolean,
    executable: Schema.Boolean, sha256: Schema.String }))
})
type Manifest = typeof Manifest.Type
type Mounts = Pick<PreparedIntegrationResources, 'skillPaths' | 'executableDirectories'>
const failure = () => new HarnessStoreError({ reason: 'storage', message: 'Task resources could not be verified. The saved snapshot has been retained.' })

/** Streams large native tools instead of retaining complete executables in the main-process heap. */
async function digest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** Enumerates ordinary asset files/directories without following links into unrelated installation data. */
async function inventory(root: string, paths: readonly string[]): Promise<Manifest['entries']> {
  const entries = new Map<string, Manifest['entries'][number]>()
  /** Overlapping declared asset roots share one inventory entry and deterministic content hash. */
  async function visit(path: string): Promise<void> {
    if (entries.has(path)) return
    const absolute = join(root, path)
    const info = await lstat(absolute)
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw failure()
    entries.set(path, { path, directory: info.isDirectory(), executable: info.isFile() && (info.mode & 0o111) !== 0,
      sha256: info.isFile() ? await digest(absolute) : '' })
    if (info.isDirectory()) for (const name of (await readdir(absolute)).sort()) await visit(join(path, name))
  }
  for (const path of paths) await visit(path)
  return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'))
}

/** Resource roots must remain inside a selected installation, without copying its credential-bearing root. */
async function sourcePath(root: string, path: string, integrationIds: readonly string[]): Promise<string> {
  if (!isAbsolute(path) || await realpath(path) !== resolve(path)) throw failure()
  const local = relative(root, path)
  const parts = local.split(sep)
  if (parts.length < 2 || !integrationIds.includes(parts[0]!) || parts.includes('..')) throw failure()
  return Schema.decodeUnknownSync(RelativePath)(local)
}

/** Rechecks declared asset trees and rejects extra files within them, byte edits and executable-mode changes. */
async function verify(directory: string, manifest: Manifest): Promise<Mounts> {
  if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) throw failure()
  const roots = [...manifest.skillPaths.map(dirname), ...manifest.executableDirectories]
  for (const path of roots) if (await realpath(join(directory, path)) !== join(directory, path)) throw failure()
  const actual = await inventory(directory, roots)
  if (JSON.stringify(actual) !== JSON.stringify(manifest.entries)) throw failure()
  return { skillPaths: manifest.skillPaths.map(path => join(directory, path)),
    executableDirectories: manifest.executableDirectories.map(path => join(directory, path)) }
}

/**
 * Pins credential-free Integration asset trees outside Git on first Session startup. SQLite owns
 * the manifest; published copies are never refreshed from an upgraded installation. Integrity
 * checks detect subsequent edits, but full access means this is not an OS security boundary.
 */
export class TaskResources extends Context.Service<TaskResources, {
  readonly prepare: (task: TaskRecord) => Effect.Effect<Mounts, HarnessStoreError>
}>()('folio/services/TaskResources') {
  static layer(vaultDirectory: string) {
    return Layer.effect(TaskResources, Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const integrations = yield* IntegrationService
      const config = yield* ConfigService
      const source = join(config.directory, 'integrations')
      const parent = join(vaultDirectory, 'resources')

      /** Existing snapshots still require a healthy selected Integration; account data is never frozen with assets. */
      const prepare = Effect.fn('TaskResources.prepare')(function*(task: TaskRecord) {
        if (!task.configuration.integrationIds.length) return { skillPaths: [], executableDirectories: [] }
        yield* Schema.decodeUnknownEffect(TaskId)(task.id)
        // Provider checks may perform bounded network I/O; cancellation is safe before any snapshot writes.
        const mounted = yield* integrations.prepare(task.configuration.integrationIds, task.worktree).pipe(Effect.interruptible)
        if (mounted.instructions.length) return yield* failure()
        const destination = join(parent, task.id)
        const read = sql<{ manifest: string; state: string }>`SELECT manifest, state FROM task_resource_snapshots WHERE task_id=${task.id}`
        const existing = (yield* read)[0]
        const present = yield* Effect.tryPromise(() => lstat(destination).then(() => true).catch(error => {
          if (error.code === 'ENOENT') return false
          throw error
        }))
        if (!existing && present) return yield* failure()
        let manifest: Manifest | undefined
        if (existing) {
          manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))(existing.manifest)
          if (manifest.taskId !== task.id || JSON.stringify(manifest.integrationIds) !== JSON.stringify(task.configuration.integrationIds)) return yield* failure()
          if (present) {
            const result = yield* Effect.tryPromise(() => verify(destination, manifest!))
            yield* sql`UPDATE task_resource_snapshots SET state='ready' WHERE task_id=${task.id}`
            return result
          }
          if (existing.state === 'ready') return yield* failure()
        }

        const prepared = yield* Effect.tryPromise(async () => {
          if (await realpath(source) !== source) throw failure()
          const skillPaths = await Promise.all(mounted.skillPaths.map(path => sourcePath(source, path, task.configuration.integrationIds)))
          const executableDirectories = await Promise.all(mounted.executableDirectories.map(path => sourcePath(source, path, task.configuration.integrationIds)))
          const roots = [...skillPaths.map(dirname), ...executableDirectories]
          // The declared Skill file must live below an asset directory, never directly at the installation root.
          if (!roots.length || roots.some(path => path.split(sep).length < 2)) throw failure()
          const candidate: Manifest = { version: 1, taskId: task.id, integrationIds: task.configuration.integrationIds,
            skillPaths, executableDirectories, entries: await inventory(source, roots) }
          if (manifest && JSON.stringify(candidate) !== JSON.stringify(manifest)) throw failure()
          await mkdir(parent, { recursive: true, mode: 0o700 })
          if (await realpath(parent) !== parent) throw failure()
          const staging = await mkdtemp(join(parent, '.staging-'))
          try {
            for (const entry of candidate.entries) {
              const target = join(staging, entry.path)
              if (entry.directory) await mkdir(target, { recursive: true, mode: 0o700 })
              else {
                await mkdir(dirname(target), { recursive: true, mode: 0o700 })
                await copyFile(join(source, entry.path), target)
                await chmod(target, entry.executable ? 0o700 : 0o600)
              }
            }
            // Detect ordinary concurrent installation changes and partial copies before publishing any intent.
            if (JSON.stringify(await inventory(source, roots)) !== JSON.stringify(candidate.entries)) throw failure()
            await verify(staging, candidate)
            return { staging, manifest: candidate }
          } catch (error) { await rm(staging, { recursive: true, force: true }); throw error }
        })
        return yield* Effect.gen(function*() {
          const encoded = JSON.stringify(prepared.manifest)
          yield* sql`INSERT INTO task_resource_snapshots (task_id, manifest, state)
            VALUES (${task.id}, ${encoded}, 'preparing') ON CONFLICT(task_id) DO NOTHING`
          // A competing initializer may have won with different bytes. Its snapshot takes precedence.
          if ((yield* read)[0]?.manifest !== encoded) return yield* failure()
          yield* Effect.tryPromise(async () => {
            try { await rename(prepared.staging, destination) }
            catch (error) {
              // A complete nonempty winner cannot be replaced by rename; accept only its exact recorded bytes.
              await verify(destination, prepared.manifest)
            }
          })
          const result = yield* Effect.tryPromise(() => verify(destination, prepared.manifest))
          yield* sql`UPDATE task_resource_snapshots SET state='ready' WHERE task_id=${task.id}`
          return result
        }).pipe(Effect.ensuring(Effect.promise(() => rm(prepared.staging, { recursive: true, force: true }))))
      }, Effect.uninterruptible, Effect.mapError(failure))
      return TaskResources.of({ prepare })
    }))
  }
}
