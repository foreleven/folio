import { NodeServices } from '@effect/platform-node'
import { ConfigProvider, Effect, Layer, Stream } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { execFile } from 'node:child_process'
import { access, chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigService } from './config-service'
import { HarnessStore } from './harness-store'
import { IntegrationService } from './integration-service'
import { TaskResources } from './task-resources'
import { vaultDatabaseLayer } from './vault-database'

const execute = promisify(execFile)
let root: string
let skill: string
let bin: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'folio-resource-snapshot-')))
  skill = join(root, 'config/integrations/notes/skills/notes/SKILL.md')
  bin = join(root, 'config/integrations/notes/cli')
  await mkdir(join(root, 'vault'))
  await mkdir(join(dirname(skill), 'references'), { recursive: true })
  await mkdir(bin)
  await writeFile(skill, '---\nname: notes\ndescription: Selected notes\n---\nRead references/usage.md.\n')
  await writeFile(join(dirname(skill), 'references/usage.md'), 'Original reference')
  await writeFile(join(dirname(skill), 'script.mjs'), 'process.stdout.write("original-script")', { mode: 0o700 })
  await writeFile(join(bin, 'tool.mjs'), 'process.stdout.write("original-tool")', { mode: 0o700 })
  await writeFile(join(root, 'config/integrations/notes/private.json'), 'credential-must-not-copy')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

/** Real Vault SQL and disk copies, with provider discovery replaced by already verified asset paths. */
function layer() {
  return TaskResources.layer(join(root, 'vault')).pipe(
    Layer.provideMerge(HarnessStore.layer), Layer.provideMerge(vaultDatabaseLayer(join(root, 'vault'))),
    Layer.provide(Layer.succeed(IntegrationService)({
      list: Effect.succeed([]), watch: Stream.empty, install: () => Effect.void, inspect: () => Effect.void, action: () => Effect.void,
      prepare: () => Effect.succeed({ skillPaths: [skill], executableDirectories: [bin], instructions: [] })
    })),
    Layer.provide(ConfigService.layer), Layer.provide(NodeServices.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ FOLIO_CONFIG_DIR: join(root, 'config') })))
  )
}

/** Records the normal Task identity first; snapshot publication is a separate recoverable operation. */
const createTask = Effect.gen(function*() {
  const store = yield* HarnessStore
  yield* store.createTask({ id: 'task', goal: 'Use resources', branch: 'folio/task/task', worktree: join(root, 'vault/worktrees/task'),
    configuration: { agent: 'pi', skillIds: [], integrationIds: ['notes'] } })
  return yield* store.task('task')
})

describe('Task resource snapshots', () => {
  it.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')('runs the bundled native Lark CLI from its pinned copy without an API request', async () => {
    await execute('/usr/bin/tar', ['-xzf', resolve('../../packages/integrations/src/lark/assets/lark-cli-1.0.94-darwin-arm64.tar.gz'), '-C', bin])
    const mounted = await Effect.runPromise(Effect.gen(function*() {
      return yield* (yield* TaskResources).prepare(yield* createTask)
    }).pipe(Effect.provide(layer())))
    expect((await execute(join(mounted.executableDirectories[0]!, 'lark-cli'), ['--version'])).stdout).toContain('1.0.94')
  })

  it('pins complete Skills and executable assets across restart, without copying installation credentials', async () => {
    const mounted = await Effect.runPromise(Effect.gen(function*() {
      return yield* (yield* TaskResources).prepare(yield* createTask)
    }).pipe(Effect.provide(layer())))
    expect(mounted.skillPaths[0]).toBe(join(root, 'vault/resources/task/notes/skills/notes/SKILL.md'))
    expect((await lstat(mounted.skillPaths[0]!)).isSymbolicLink()).toBe(false)
    expect(await readFile(join(dirname(mounted.skillPaths[0]!), 'references/usage.md'), 'utf8')).toBe('Original reference')
    await expect(access(join(root, 'vault/resources/task/notes/private.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(join(dirname(skill), 'script.mjs'), 'process.stdout.write("upgraded-script")')
    await writeFile(join(bin, 'tool.mjs'), 'process.stdout.write("upgraded-tool")')
    const restored = await Effect.runPromise(Effect.gen(function*() {
      return yield* (yield* TaskResources).prepare(yield* (yield* HarnessStore).task('task'))
    }).pipe(Effect.provide(layer())))
    expect(restored).toEqual(mounted)
    expect((await execute(process.execPath, [join(dirname(restored.skillPaths[0]!), 'script.mjs')])).stdout).toBe('original-script')
    expect((await execute(process.execPath, [join(restored.executableDirectories[0]!, 'tool.mjs')])).stdout).toBe('original-tool')
  })

  it.each(['edited', 'extra', 'mode', 'missing', 'missing-ledger'] as const)('rejects a %s snapshot without replacing it from the installation', async damage => {
    const mounted = await Effect.runPromise(Effect.gen(function*() {
      return yield* (yield* TaskResources).prepare(yield* createTask)
    }).pipe(Effect.provide(layer())))
    const entry = mounted.skillPaths[0]!
    if (damage === 'edited') await writeFile(entry, 'changed snapshot')
    if (damage === 'extra') await writeFile(join(dirname(entry), 'extra.md'), 'unexpected')
    if (damage === 'mode') await chmod(entry, 0o700)
    if (damage === 'missing') await rm(join(root, 'vault/resources/task'), { recursive: true })
    await Effect.runPromise(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      if (damage === 'missing-ledger') yield* sql`DELETE FROM task_resource_snapshots WHERE task_id='task'`
      const task = yield* (yield* HarnessStore).task('task')
      expect(yield* (yield* TaskResources).prepare(task).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
    }).pipe(Effect.provide(layer())))
    if (damage === 'edited') expect(await readFile(entry, 'utf8')).toBe('changed snapshot')
    if (damage === 'missing') await expect(access(entry)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(skill, 'utf8')).toContain('Selected notes')
  })

  it('recovers filesystem publication after the final SQL receipt fails', async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const task = yield* createTask
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TRIGGER fail_ready BEFORE UPDATE OF state ON task_resource_snapshots
        BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END`
      expect(yield* (yield* TaskResources).prepare(task).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
      expect((yield* sql<{ state: string }>`SELECT state FROM task_resource_snapshots`)[0]?.state).toBe('preparing')
      yield* sql`DROP TRIGGER fail_ready`
    }).pipe(Effect.provide(layer())))
    await writeFile(skill, 'upgraded installation must not replace published bytes')
    await Effect.runPromise(Effect.gen(function*() {
      const mounts = yield* (yield* TaskResources).prepare(yield* (yield* HarnessStore).task('task'))
      expect(yield* Effect.promise(() => readFile(mounts.skillPaths[0]!, 'utf8'))).toContain('Selected notes')
      const sql = yield* SqlClient.SqlClient
      expect((yield* sql<{ state: string }>`SELECT state FROM task_resource_snapshots`)[0]?.state).toBe('ready')
    }).pipe(Effect.provide(layer())))
  })

  it('rejects linked source assets before publishing a manifest or copying private data', async () => {
    await symlink(join(root, 'config/integrations/notes/private.json'), join(dirname(skill), 'linked.json'))
    await Effect.runPromise(Effect.gen(function*() {
      const task = yield* createTask
      expect(yield* (yield* TaskResources).prepare(task).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
      const sql = yield* SqlClient.SqlClient
      expect(yield* sql`SELECT * FROM task_resource_snapshots`).toEqual([])
    }).pipe(Effect.provide(layer())))
    await expect(access(join(root, 'vault/resources/task'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([false, true])('reconstructs an unpublished recorded snapshot only if source bytes still match; changed=%s', async changed => {
    await Effect.runPromise(Effect.gen(function*() {
      yield* (yield* TaskResources).prepare(yield* createTask)
      const sql = yield* SqlClient.SqlClient
      // Simulate the journal checkpoint after intent commit and before directory publication.
      yield* sql`UPDATE task_resource_snapshots SET state='preparing' WHERE task_id='task'`
    }).pipe(Effect.provide(layer())))
    await rm(join(root, 'vault/resources/task'), { recursive: true })
    if (changed) await writeFile(skill, 'different source version')
    await Effect.runPromise(Effect.gen(function*() {
      const resources = yield* TaskResources
      const task = yield* (yield* HarnessStore).task('task')
      if (changed) expect(yield* resources.prepare(task).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
      else expect((yield* resources.prepare(task)).skillPaths).toHaveLength(1)
      const sql = yield* SqlClient.SqlClient
      expect((yield* sql<{ state: string }>`SELECT state FROM task_resource_snapshots`)[0]?.state).toBe(changed ? 'preparing' : 'ready')
    }).pipe(Effect.provide(layer())))
  })

  it('coalesces competing publication through the recorded manifest without replacing the winner', async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const task = yield* createTask
      const resources = yield* TaskResources
      const [first, second] = yield* Effect.all([resources.prepare(task), resources.prepare(task)], { concurrency: 'unbounded' })
      expect(first).toEqual(second)
      const sql = yield* SqlClient.SqlClient
      expect(yield* sql`SELECT state FROM task_resource_snapshots`).toEqual([{ state: 'ready' }])
    }).pipe(Effect.provide(layer())))
  })

  it('rejects a redirected ancestor even when all asset bytes still match', async () => {
    await Effect.runPromise(Effect.gen(function*() {
      yield* (yield* TaskResources).prepare(yield* createTask)
    }).pipe(Effect.provide(layer())))
    const original = join(root, 'vault/resources/task/notes')
    const moved = join(root, 'redirected-assets')
    await rename(original, moved)
    await symlink(moved, original, process.platform === 'win32' ? 'junction' : 'dir')
    await Effect.runPromise(Effect.gen(function*() {
      expect(yield* (yield* TaskResources).prepare(yield* (yield* HarnessStore).task('task')).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
    }).pipe(Effect.provide(layer())))
    expect(await readFile(join(moved, 'skills/notes/SKILL.md'), 'utf8')).toContain('Selected notes')
  })
})
