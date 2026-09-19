import { Effect, Layer, Logger, Stream } from 'effect'
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type TaskRecord } from '../../../shared/harness'
import { IntegrationSettingsError } from '../../../shared/integration'
import { IntegrationService, type PreparedIntegrationResources } from '../integrations/integration-service'
import { TaskResources } from './task-resources'

let root: string
let task: TaskRecord
let mounted: PreparedIntegrationResources
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'folio-task-resources-')))
  const skill = join(root, 'config/integrations/notes/skills/notes/SKILL.md')
  const bin = join(root, 'config/integrations/notes/cli')
  const worktree = join(root, 'vault/worktrees/task')
  await mkdir(dirname(skill), { recursive: true })
  await mkdir(bin)
  await mkdir(worktree, { recursive: true })
  await writeFile(skill, 'original skill')
  task = { id: 'task', goal: 'Use resources', branch: 'folio/task/task', worktree,
    configuration: { agent: 'pi', skillIds: [], integrationIds: ['notes'], resourceIds: ['notes/im'] },
    state: 'active', worktreeState: 'ready', worktreeBase: null, createdAt: 1 }
  mounted = { skillPaths: [skill], executableDirectories: [bin], instructions: [] }
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

/** No SQL/config dependency: the provider owns installation validation and authorization. */
function fixture(prepare = vi.fn<IntegrationService['Service']['prepare']>(() => Effect.succeed(mounted))) {
  const layer = TaskResources.layer.pipe(Layer.provide(Layer.succeed(IntegrationService)({
    list: Effect.succeed([]), watch: Stream.empty, install: () => Effect.void,
    inspect: () => Effect.void, action: () => Effect.void, prepare
  })))
  return { prepare, run: () => Effect.runPromise(Effect.gen(function*() {
    return yield* (yield* TaskResources).prepare(task)
  }).pipe(Effect.provide(layer))), layer }
}

describe('Task resources', () => {
  it('uses installed assets directly and follows upgrades without creating task copies', async () => {
    const f = fixture()
    expect(await f.run()).toEqual({ skillPaths: mounted.skillPaths, executableDirectories: mounted.executableDirectories })
    await writeFile(mounted.skillPaths[0]!, 'upgraded skill')
    const restored = await f.run()
    expect(await readFile(restored.skillPaths[0]!, 'utf8')).toBe('upgraded skill')
    expect(f.prepare).toHaveBeenCalledTimes(2)
    expect(f.prepare).toHaveBeenLastCalledWith(['notes'], task.worktree, ['notes/im'])
    await expect(access(join(root, 'vault/resources'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refreshes runtime credentials and workspace files on every preparation', async () => {
    mounted = { ...mounted, environment: { NOTES_TOKEN: 'first-token' },
      instructions: ['Read the workflow.'], workspaceFiles: [{ path: 'raws/notes/workflow.mjs', content: 'first workflow' }] }
    const f = fixture()
    expect((await f.run()).environment).toEqual({ NOTES_TOKEN: 'first-token' })
    expect(await readFile(join(task.worktree, 'raws/.folio-integration-instructions.md'), 'utf8')).toBe('Read the workflow.\n')
    mounted = { ...mounted, environment: { NOTES_TOKEN: 'fresh-token' },
      workspaceFiles: [{ path: 'raws/notes/workflow.mjs', content: 'new workflow' }] }
    expect((await f.run()).environment).toEqual({ NOTES_TOKEN: 'fresh-token' })
    expect(await readFile(join(task.worktree, 'raws/notes/workflow.mjs'), 'utf8')).toBe('new workflow')
  })

  it('does not prepare providers when no integration is selected', async () => {
    task = { ...task, configuration: { ...task.configuration, integrationIds: [], resourceIds: [] } }
    const f = fixture()
    expect(await f.run()).toEqual({ skillPaths: [], executableDirectories: [] })
    expect(f.prepare).not.toHaveBeenCalled()
  })

  it('propagates provider failure with stage diagnostics and no snapshot wording', async () => {
    const logs: unknown[] = []
    const f = fixture(vi.fn(() => Effect.fail(new IntegrationSettingsError({ message: 'Integration unavailable' }))))
    const error = await Effect.runPromise(Effect.gen(function*() {
      return yield* (yield* TaskResources).prepare(task).pipe(Effect.flip)
    }).pipe(Effect.provide(f.layer), Effect.provide(Logger.layer([Logger.make(({ message }) => { logs.push(message) })]))))
    expect(error.message).toBe('Task resources could not be prepared. Check the selected integrations and try again.')
    expect(JSON.stringify(logs)).toContain('prepare-integrations')
    expect(JSON.stringify(logs)).toContain('Integration unavailable')
    await expect(access(join(task.worktree, 'raws'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['../outside.md', 'raws/../../outside.md', '/raws/outside.md'])('rejects invalid workspace path %s', async path => {
    mounted = { ...mounted, workspaceFiles: [{ path, content: 'invalid' }] }
    await expect(fixture().run()).rejects.toThrow('Task resources could not be prepared')
    await expect(access(join(root, 'outside.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['parent', 'file'] as const)('rejects redirected workspace %s without changing its target', async kind => {
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'keep.md'), 'unchanged')
    if (kind === 'parent') await symlink(outside, join(task.worktree, 'raws'), 'dir')
    else {
      await mkdir(join(task.worktree, 'raws'))
      await symlink(join(outside, 'keep.md'), join(task.worktree, 'raws/keep.md'))
    }
    mounted = { ...mounted, workspaceFiles: [{ path: 'raws/keep.md', content: 'changed' }] }
    await expect(fixture().run()).rejects.toThrow('Task resources could not be prepared')
    expect(await readFile(join(outside, 'keep.md'), 'utf8')).toBe('unchanged')
  })
})
