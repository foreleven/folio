import { SessionArchive } from '@folio/agent'
import { HarnessStore } from '../services/harness-store'
import { HarnessEventStore } from '../services/harness-event-store'
import { openHarnessSession } from '../services/harness-session'
import { vaultDatabaseLayer } from '../services/vault-database'
import { ModelService } from '../services/model-service'
import { NodeServices } from '@effect/platform-node'
import { ConfigProvider, Effect, Fiber, Layer, ManagedRuntime, Redacted, Exit, Scope } from 'effect'
import { RpcTest } from 'effect/unstable/rpc'
import { mkdir, mkdtemp, realpath, rm, writeFile, readFile, readdir, rename, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { v7 as uuidv7 } from 'uuid'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentRuntime, AgentRuntimeError } from '../services/agent-runtime'
import { TaskRpcs } from '../../shared/rpc/task-rpc'
import { ConfigService } from '../services/config-service'
import { TaskService } from '../services/task-service'
import { VaultService } from '../services/vault-service'
import { TaskRpcHandlersLive } from './task-rpc'
import type { Integration } from '@folio/integrations/base'
import { IntegrationService } from '../services/integration-service'
import { IntegrationStore } from '../services/integration-store'
import { IntegrationCatalog } from '../services/integration-catalog'
import { IntegrationBrowser } from '../electron/IntegrationBrowser'
import { makeVaultGit } from '../services/vault-git'

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'folio-task-rpc-')))
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

/** Exercises real registration, SQLite, Git and RPC handlers with application-owned resources. */
function runtime(
  get: AgentRuntime['Service']['get'] = Effect.succeed({ nodeExecutable: process.execPath, entrypoint: resolve('../../packages/agent/dist/cli.js'), agentVersion: '0.1.0' }),
  catalog: readonly Integration[] = []
) {
  return ManagedRuntime.make(
    TaskRpcHandlersLive.pipe(
      Layer.provideMerge(TaskService.layer),
      Layer.provideMerge(VaultService.layer),
      Layer.provideMerge(IntegrationService.layer),
      Layer.provideMerge(IntegrationStore.layer),
      Layer.provide(Layer.succeed(IntegrationCatalog)(catalog)),
      Layer.provide(Layer.succeed(IntegrationBrowser)({ open: () => Effect.void })),
      Layer.provide(Layer.succeed(AgentRuntime)({ get })),
      Layer.provideMerge(ModelService.layer({ environment: {} })),
      Layer.provideMerge(ConfigService.layer),
      Layer.provide(NodeServices.layer),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ FOLIO_CONFIG_DIR: join(root, 'config') })))
    )
  )
}

describe('Task application RPC', () => {
  it('saves selected main-workspace files over RPC and retries after restart without starting an Agent', async () => {
    await mkdir(join(root, 'wiki'))
    const probe = vi.fn()
    const unavailable = Effect.sync(probe).pipe(Effect.andThen(Effect.fail(new AgentRuntimeError({ reason: 'unavailable', message: 'fixture' }))))
    const app = runtime(unavailable)
    let vaultId = ''
    let parent = ''
    let commit = ''
    const id = uuidv7()
    try {
      await app.runPromise(
        Effect.gen(function* () {
          vaultId = (yield* (yield* VaultService).register(join(root, 'wiki'))).id
          const workspace = join(root, 'config/vaults', vaultId, 'workspace')
          const git = yield* makeVaultGit
          parent = (yield* git(workspace, ['rev-parse', 'HEAD'])).trim()
          yield* Effect.promise(async () => {
            await writeFile(join(workspace, 'wiki/selected.md'), 'user-selected content')
            await writeFile(join(workspace, 'wiki/draft.md'), 'unselected staged draft')
          })
          yield* git(workspace, ['add', '--', 'wiki/draft.md'])
          const client = yield* RpcTest.makeClient(TaskRpcs)
          const changes = yield* client['workspace.changes']({ vaultId })
          expect(changes).toMatchObject({ head: parent, registered: true, pending: [] })
          expect(changes.files.map((file) => file.path).sort()).toEqual(['wiki/draft.md', 'wiki/selected.md'])
          const preview = yield* client['workspace.diff']({ vaultId, input: { expectedParent: parent, path: 'wiki/selected.md', saveId: null } })
          expect(preview.text).toContain('+user-selected content')
          expect((yield* client['workspace.changes']({ vaultId })).pending).toEqual([])
          const saved = yield* client['workspace.saveFiles']({ vaultId, input: { id, expectedParent: parent, paths: ['wiki/selected.md'] } })
          commit = saved.commit
          expect(saved).toMatchObject({ id, branch: 'main', state: 'applied' })
          expect(yield* git(workspace, ['show', 'HEAD:wiki/selected.md'])).toBe('user-selected content')
          expect((yield* git(workspace, ['diff', '--cached', '--name-only'])).trim()).toBe('wiki/draft.md')
          expect(yield* client['tasks.list']({ vaultId })).toEqual([])
          const service = yield* TaskService
          // @ts-expect-error The public main save must not accept a Task selector.
          expect(yield* service.saveWorkspaceFiles(vaultId, { id, expectedParent: parent, paths: ['wiki/selected.md'], taskId: uuidv7() }).pipe(Effect.flip)).toMatchObject({
            reason: 'storage'
          })
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
      )
    } finally {
      await app.dispose()
    }
    const workspace = join(root, 'config/vaults', vaultId, 'workspace')
    await writeFile(join(workspace, 'wiki/selected.md'), 'newer uncommitted text')
    const reopened = runtime(unavailable)
    try {
      await reopened.runPromise(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(TaskRpcs)
          expect(yield* client['workspace.saveFiles']({ vaultId, input: { id, expectedParent: parent, paths: ['wiki/selected.md'] } })).toMatchObject({ commit, state: 'applied' })
          expect(yield* client['workspace.saveFiles']({ vaultId: uuidv7(), input: { id, expectedParent: parent, paths: ['wiki/selected.md'] } }).pipe(Effect.flip)).toMatchObject({
            reason: 'not-found'
          })
          expect(yield* client['workspace.changes']({ vaultId: uuidv7() }).pipe(Effect.flip)).toMatchObject({ reason: 'not-found' })
          const original = yield* client['workspace.diff']({ vaultId, input: { expectedParent: parent, path: 'wiki/selected.md', saveId: id } })
          expect(original.text).toContain('+user-selected content')
          expect(original.text).not.toContain('newer uncommitted text')
          expect(yield* Effect.promise(() => readFile(join(workspace, 'wiki/selected.md'), 'utf8'))).toBe('newer uncommitted text')
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
      )
      expect(probe).not.toHaveBeenCalled()
    } finally {
      await reopened.dispose()
    }
  }, 15_000)

  it('saves an explicitly selected Task wiki file and synchronizes it through durable RPC identities', async () => {
    await mkdir(join(root, 'wiki'))
    const probe = vi.fn()
    const unavailable = Effect.sync(probe).pipe(Effect.andThen(Effect.fail(new AgentRuntimeError({ reason: 'unavailable', message: 'fixture' }))))
    const app = runtime(unavailable)
    try {
      await app.runPromise(
        Effect.gen(function* () {
          const vault = yield* (yield* VaultService).register(join(root, 'wiki'))
          const client = yield* RpcTest.makeClient(TaskRpcs)
          const taskId = uuidv7()
          const saveId = uuidv7()
          const synchronizationId = uuidv7()
          const task = yield* client['tasks.create']({ vaultId: vault.id, id: taskId, goal: 'Manually edit wiki', agent: 'codex', integrationIds: [] })
          expect(task.worktreeBase).not.toBeNull()
          const originalAgents = yield* Effect.promise(() => readFile(join(task.worktree, 'AGENTS.md'), 'utf8'))
          yield* Effect.promise(async () => {
            await writeFile(join(task.worktree, 'wiki/manual.md'), 'manual Task content\n')
            await writeFile(join(task.worktree, 'AGENTS.md'), 'unrelated Task draft\n')
          })
          const changes = yield* client['tasks.wikiChanges']({ vaultId: vault.id, taskId })
          expect(changes).toMatchObject({ head: task.worktreeBase, registered: true, files: [{ path: 'wiki/manual.md', status: 'added', selectable: true }] })
          const preview = yield* client['tasks.wikiDiff']({
            vaultId: vault.id,
            taskId,
            input: { expectedParent: task.worktreeBase!, path: 'wiki/manual.md', saveId: null }
          })
          expect(preview).toMatchObject({ kind: 'text' })
          expect(preview.text).toContain('+manual Task content')
          expect(
            yield* client['tasks.wikiDiff']({
              vaultId: vault.id,
              taskId,
              input: { expectedParent: task.worktreeBase!, path: 'AGENTS.md', saveId: null }
            }).pipe(Effect.flip)
          ).toMatchObject({ reason: 'invalid-state' })

          const saved = yield* client['tasks.saveWikiFiles']({
            vaultId: vault.id,
            input: { id: saveId, taskId, expectedParent: task.worktreeBase!, paths: ['wiki/manual.md'] }
          })
          expect(saved).toMatchObject({ id: saveId, branch: `folio/task/${taskId}`, state: 'applied' })
          expect(yield* Effect.promise(() => readFile(join(task.worktree, 'AGENTS.md'), 'utf8'))).toBe('unrelated Task draft\n')
          yield* Effect.promise(() => writeFile(join(task.worktree, 'AGENTS.md'), originalAgents))
          const synchronized = yield* client['tasks.synchronizeWiki']({
            vaultId: vault.id,
            input: { id: synchronizationId, taskId, expectedSourceHead: saved.commit }
          })
          expect(synchronized).toMatchObject({ id: synchronizationId, taskId, sourceHead: saved.commit, state: 'aligned' })
          expect(yield* client['tasks.synchronization']({ vaultId: vault.id, id: synchronizationId })).toEqual(synchronized)
          expect(
            yield* client['tasks.saveWikiFiles']({
              vaultId: vault.id,
              input: { id: saveId, taskId, expectedParent: task.worktreeBase!, paths: ['wiki/manual.md'] }
            })
          ).toEqual(saved)
          expect(
            yield* client['tasks.synchronizeWiki']({
              vaultId: vault.id,
              input: { id: synchronizationId, taskId, expectedSourceHead: saved.commit }
            })
          ).toEqual(synchronized)

          const git = yield* makeVaultGit
          const workspace = join(root, 'config/vaults', vault.id, 'workspace')
          expect(yield* git(workspace, ['show', 'HEAD:wiki/manual.md'])).toBe('manual Task content\n')
          expect((yield* git(task.worktree, ['rev-parse', 'HEAD^{tree}'])).trim()).toBe((yield* git(workspace, ['rev-parse', 'HEAD^{tree}'])).trim())
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
      )
      expect(probe).not.toHaveBeenCalled()
    } finally {
      await app.dispose()
    }
  }, 20_000)

  it.skipIf(process.platform === 'win32')('runs conflict resolution in the isolated coordinator and lets Folio publish the edited result', async () => {
    await mkdir(join(root, 'wiki'))
    let fixture = await readFile(resolve('../../packages/agent/tests/fixtures/codex-app-server.mjs'), 'utf8')
    fixture = fixture.replace('id: "native-thread"', 'id: process.cwd()')
    for (const name of ['native-thread.json', 'resumed.json', 'terminal-cleanup.json', 'turn-input.json', 'skill-roots.json']) {
      fixture = fixture.replaceAll(`"${name}"`, JSON.stringify(join(root, name))).replaceAll(`'${name}'`, JSON.stringify(join(root, name)))
    }
    fixture = fixture.replace(
      'const mode = params.input[0].text;',
      'const mode = params.input[0].text; writeFileSync(join(process.cwd(), "wiki/note.md"), "main version\\ntask version\\n");'
    )
    await writeFile(join(root, 'codex'), `#!/usr/bin/env node\n${fixture}`, { mode: 0o700 })
    vi.stubEnv('FOLIO_CODEX_EXECUTABLE', join(root, 'codex'))
    const app = runtime(Effect.succeed({ nodeExecutable: process.execPath, entrypoint: resolve('../../packages/agent/dist/cli.js'), agentVersion: '0.1.0', codexExecutable: join(root, 'codex') }))
    try {
      await app.runPromise(
        Effect.gen(function* () {
          const vault = yield* (yield* VaultService).register(join(root, 'wiki'))
          const client = yield* RpcTest.makeClient(TaskRpcs)
          const taskId = uuidv7(), sourceSessionId = uuidv7(), conflictSessionId = uuidv7(), runId = uuidv7()
          const taskSaveId = uuidv7(), mainSaveId = uuidv7(), operationId = uuidv7()
          const task = yield* client['tasks.create']({ vaultId: vault.id, id: taskId, goal: 'Keep both note versions', agent: 'codex' })
          yield* client['tasks.openSession']({ vaultId: vault.id, taskId, sessionId: sourceSessionId, agent: 'codex' })
          yield* client['tasks.closeSession']({ vaultId: vault.id, taskId, sessionId: sourceSessionId })
          yield* Effect.promise(() => writeFile(join(task.worktree, 'wiki/note.md'), 'task version\n'))
          const taskSource = yield* client['tasks.saveWikiFiles']({ vaultId: vault.id,
            input: { id: taskSaveId, taskId, expectedParent: task.worktreeBase!, paths: ['wiki/note.md'] } })
          const workspace = join(root, 'config/vaults', vault.id, 'workspace')
          yield* Effect.promise(() => writeFile(join(workspace, 'wiki/note.md'), 'main version\n'))
          yield* client['workspace.saveFiles']({ vaultId: vault.id,
            input: { id: mainSaveId, expectedParent: task.worktreeBase!, paths: ['wiki/note.md'] } })
          const conflict = yield* client['tasks.synchronizeWiki']({ vaultId: vault.id,
            input: { id: operationId, taskId, expectedSourceHead: taskSource.commit } })
          expect(conflict.state).toBe('conflict')
          const context = yield* client['tasks.wikiConflictContext']({ vaultId: vault.id, taskId, id: operationId })
          expect(context.files).toEqual(['wiki/note.md'])
          expect(context.canonicalDiff).toContain('main version')
          expect(context.taskDiff).toContain('task version')

          const started = yield* client['tasks.startConflictResolution']({ vaultId: vault.id, taskId,
            operationId, sourceSessionId, sessionId: conflictSessionId, runId })
          expect(started).toMatchObject({ id: runId, purpose: 'conflict-resolution', syncState: 'not-required' })
          yield* Effect.promise(() => vi.waitFor(async () => {
            const detail = await app.runPromise(Effect.flatMap(TaskService, (service) => service.get(vault.id, taskId)))
            expect(detail.runs.find((run) => run.id === runId)).toMatchObject({ state: 'succeeded', purpose: 'conflict-resolution' })
            expect(await app.runPromise(Effect.flatMap(TaskService, (service) => service.taskSynchronization(vault.id, operationId)))).toMatchObject({ state: 'aligned' })
          }, { timeout: 15_000 }))

          const detail = yield* client['tasks.get']({ vaultId: vault.id, id: taskId })
          expect(detail.sessions.find((session) => session.id === conflictSessionId)).toMatchObject({
            purpose: 'conflict-resolution', syncOperationId: operationId, agent: 'codex'
          })
          expect(detail.runs.find((run) => run.id === runId)?.baselineCommit).toBe(conflict.mainBase)
          expect(yield* Effect.promise(() => readFile(join(workspace, 'wiki/note.md'), 'utf8'))).toBe('main version\ntask version\n')
          expect(yield* Effect.promise(() => readFile(join(task.worktree, 'wiki/note.md'), 'utf8'))).toBe('main version\ntask version\n')
          const history = yield* client['tasks.sessionHistory']({ vaultId: vault.id, taskId, sessionId: conflictSessionId })
          const prompt = JSON.stringify(history.messages.find((message) => message.data.role === 'user')?.data ?? '')
          expect(prompt).toContain('Task goal: Keep both note versions')
          expect(prompt).toContain('Canonical/main-side diff:')
          expect(prompt).toContain('Task-side diff:')
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
      )
    } finally {
      await app.dispose()
    }
  }, 30_000)

  it('reopens a released Task from the current registered main and retains the old branch head', async () => {
    await mkdir(join(root, 'wiki'))
    const unavailable = Effect.fail(new AgentRuntimeError({ reason: 'unavailable', message: 'fixture' }))
    const app = runtime(unavailable)
    try {
      await app.runPromise(
        Effect.gen(function* () {
          const vault = yield* (yield* VaultService).register(join(root, 'wiki'))
          const client = yield* RpcTest.makeClient(TaskRpcs)
          const taskId = uuidv7()
          const task = yield* client['tasks.create']({ vaultId: vault.id, id: taskId, goal: 'Reopen after main advances', agent: 'pi' })
          const completed = yield* client['tasks.complete']({ vaultId: vault.id, taskId })
          const workspace = join(root, 'config/vaults', vault.id, 'workspace')
          const git = yield* makeVaultGit
          const parent = (yield* git(workspace, ['rev-parse', 'HEAD'])).trim()
          yield* Effect.promise(() => writeFile(join(workspace, 'wiki/after-complete.md'), 'main content'))
          const saved = yield* client['workspace.saveFiles']({ vaultId: vault.id, input: {
            id: uuidv7(), expectedParent: parent, paths: ['wiki/after-complete.md']
          } })
          const reopened = yield* client['tasks.reopen']({ vaultId: vault.id, taskId })
          expect(reopened).toMatchObject({ id: taskId, state: 'active', worktreeState: 'ready', worktreeBase: saved.commit })
          expect(yield* Effect.promise(() => access(reopened.worktree).then(() => 'exists'))).toBe('exists')
          expect(yield* Effect.promise(() => readFile(join(reopened.worktree, 'wiki/after-complete.md'), 'utf8'))).toBe('main content')
          expect((yield* git(reopened.worktree, ['rev-parse', 'HEAD'])).trim()).toBe(saved.commit)
          expect((yield* git(workspace, ['rev-parse', `refs/folio/task/${taskId}/reopen/${saved.commit}`])).trim()).toBe(completed.worktreeBase)
          expect(yield* client['tasks.reopen']({ vaultId: vault.id, taskId }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
      )
    } finally {
      await app.dispose()
    }
  }, 25_000)

  it.skipIf(process.platform === 'win32')('attributes an explicit Run wiki save and projects synchronization receipts over RPC', async () => {
    await mkdir(join(root, 'wiki'))
    const fixture = await readFile(resolve('../../packages/agent/tests/fixtures/codex-app-server.mjs'), 'utf8')
    await writeFile(join(root, 'codex'), `#!/usr/bin/env node\n${fixture}`, { mode: 0o700 })
    vi.stubEnv('FOLIO_CODEX_EXECUTABLE', join(root, 'codex'))
    const app = runtime()
    try {
      await app.runPromise(
        Effect.gen(function* () {
          const vault = yield* (yield* VaultService).register(join(root, 'wiki'))
          const client = yield* RpcTest.makeClient(TaskRpcs)
          const taskId = uuidv7()
          const sessionId = uuidv7()
          const runId = uuidv7()
          const saveId = uuidv7()
          const synchronizationId = uuidv7()
          const task = yield* client['tasks.create']({ vaultId: vault.id, id: taskId, goal: 'Save one Run explicitly', agent: 'codex' })
          yield* client['tasks.openSession']({ vaultId: vault.id, taskId, sessionId, agent: 'codex' })
          yield* client['tasks.startRun']({ vaultId: vault.id, id: runId, taskId, sessionId, prompt: 'early-completion', purpose: 'execution', resumesRunId: null })
          yield* Effect.promise(() =>
            vi.waitFor(async () => {
              const detail = await app.runPromise(Effect.flatMap(TaskService, (service) => service.get(vault.id, taskId)))
              expect(detail.runs).toMatchObject([{ id: runId, state: 'succeeded', syncState: 'pending' }])
            })
          )
          yield* Effect.promise(() =>
            Promise.all(['native-thread.json', 'skill-roots.json', 'turn-input.json', 'terminal-cleanup.json'].map((name) => rm(join(task.worktree, name), { force: true })))
          )
          const git = yield* makeVaultGit
          expect((yield* git(task.worktree, ['status', '--porcelain', '--untracked-files=all'])).trim()).toBe('')
          expect(yield* client['tasks.complete']({ vaultId: vault.id, taskId }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
          expect(yield* Effect.promise(() => access(task.worktree).then(() => 'exists'))).toBe('exists')
          yield* Effect.promise(() => writeFile(join(task.worktree, 'wiki/from-run.md'), 'accepted Run output\n'))
          const saved = yield* client['tasks.saveRunWikiFiles']({
            vaultId: vault.id,
            input: { id: saveId, taskId, runIds: [runId], expectedParent: task.worktreeBase!, paths: ['wiki/from-run.md'] }
          })
          expect((yield* client['tasks.get']({ vaultId: vault.id, id: taskId })).runs[0]?.syncState).toBe('pending')
          const synchronized = yield* client['tasks.synchronizeWiki']({
            vaultId: vault.id,
            input: { id: synchronizationId, taskId, expectedSourceHead: saved.commit }
          })
          expect(synchronized.state).toBe('aligned')
          expect((yield* client['tasks.get']({ vaultId: vault.id, id: taskId })).runs[0]?.syncState).toBe('completed')
          expect(yield* client['tasks.saveRunWikiFiles']({
            vaultId: vault.id,
            input: { id: saveId, taskId, runIds: [runId], expectedParent: task.worktreeBase!, paths: ['wiki/from-run.md'] }
          })).toEqual(saved)
          const workspace = join(root, 'config/vaults', vault.id, 'workspace')
          expect(yield* git(workspace, ['show', 'HEAD:wiki/from-run.md'])).toBe('accepted Run output\n')

          const beforeCompletion = yield* client['tasks.get']({ vaultId: vault.id, id: taskId })
          const beforeHistory = yield* client['tasks.sessionHistory']({ vaultId: vault.id, taskId, sessionId })
          const completed = yield* client['tasks.complete']({ vaultId: vault.id, taskId })
          expect(completed).toMatchObject({ id: taskId, state: 'completed', worktreeState: 'released' })
          expect(yield* client['tasks.complete']({ vaultId: vault.id, taskId })).toEqual(completed)
          expect(yield* Effect.promise(() => access(task.worktree).then(() => 'exists', (error: NodeJS.ErrnoException) => error.code))).toBe('ENOENT')
          expect((yield* git(workspace, ['rev-parse', `refs/heads/folio/task/${taskId}`])).trim()).toBe(synchronized.alignedHead)
          const afterCompletion = yield* client['tasks.get']({ vaultId: vault.id, id: taskId })
          expect(afterCompletion).toMatchObject({
            task: { id: taskId, state: 'completed', worktreeState: 'released' },
            sessions: beforeCompletion.sessions,
            runs: beforeCompletion.runs
          })
          expect(yield* client['tasks.sessionHistory']({ vaultId: vault.id, taskId, sessionId })).toEqual(beforeHistory)
          // Retrying the original create identity remains read-only after completion.
          expect(yield* client['tasks.create']({ vaultId: vault.id, id: taskId, goal: 'Save one Run explicitly', agent: 'codex' })).toEqual(completed)
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
      )
    } finally {
      await app.dispose()
    }
  }, 25_000)

  it.skipIf(process.platform === 'win32')('confirms a successful Run with no wiki changes before releasing its Task', async () => {
    await mkdir(join(root, 'wiki'))
    const fixture = await readFile(resolve('../../packages/agent/tests/fixtures/codex-app-server.mjs'), 'utf8')
    await writeFile(join(root, 'codex'), `#!/usr/bin/env node\n${fixture}`, { mode: 0o700 })
    vi.stubEnv('FOLIO_CODEX_EXECUTABLE', join(root, 'codex'))
    const app = runtime()
    try {
      await app.runPromise(
        Effect.gen(function* () {
          const vault = yield* (yield* VaultService).register(join(root, 'wiki'))
          const client = yield* RpcTest.makeClient(TaskRpcs)
          const taskId = uuidv7()
          const sessionId = uuidv7()
          const runId = uuidv7()
          const task = yield* client['tasks.create']({ vaultId: vault.id, id: taskId, goal: 'Inspect without changing wiki', agent: 'codex' })
          yield* client['tasks.openSession']({ vaultId: vault.id, taskId, sessionId, agent: 'codex' })
          yield* client['tasks.startRun']({
            vaultId: vault.id,
            id: runId,
            taskId,
            sessionId,
            prompt: 'early-completion',
            purpose: 'execution',
            resumesRunId: null
          })
          yield* Effect.promise(() =>
            vi.waitFor(async () => {
              const detail = await app.runPromise(Effect.flatMap(TaskService, (service) => service.get(vault.id, taskId)))
              expect(detail.runs).toMatchObject([{ id: runId, state: 'succeeded', syncState: 'pending' }])
            })
          )
          yield* Effect.promise(() =>
            Promise.all(['native-thread.json', 'skill-roots.json', 'turn-input.json', 'terminal-cleanup.json'].map((name) => rm(join(task.worktree, name), { force: true })))
          )

          const input = { taskId, runId, expectedHead: task.worktreeBase! }
          const confirmed = yield* client['tasks.confirmRunWikiUnchanged']({ vaultId: vault.id, input })
          expect(confirmed).toMatchObject({ id: runId, state: 'succeeded', syncState: 'not-required', baselineCommit: task.worktreeBase })
          expect(yield* client['tasks.confirmRunWikiUnchanged']({ vaultId: vault.id, input })).toEqual(confirmed)
          expect(
            yield* client['tasks.confirmRunWikiUnchanged']({ vaultId: vault.id, input: { ...input, expectedHead: '0'.repeat(40) } }).pipe(Effect.flip)
          ).toMatchObject({ reason: 'invalid-state' })

          const completed = yield* client['tasks.complete']({ vaultId: vault.id, taskId })
          expect(completed).toMatchObject({ state: 'completed', worktreeState: 'released' })
          expect(yield* client['tasks.confirmRunWikiUnchanged']({ vaultId: vault.id, input })).toEqual(confirmed)
          const git = yield* makeVaultGit
          const workspace = join(root, 'config/vaults', vault.id, 'workspace')
          expect((yield* git(workspace, ['rev-parse', 'HEAD'])).trim()).toBe(task.worktreeBase)
          expect((yield* git(workspace, ['rev-parse', `refs/heads/folio/task/${taskId}`])).trim()).toBe(task.worktreeBase)
          expect(yield* Effect.promise(() => access(task.worktree).then(() => 'exists', (error: NodeJS.ErrnoException) => error.code))).toBe('ENOENT')
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
      )
    } finally {
      await app.dispose()
    }
  }, 20_000)

  it.skipIf(process.platform === 'win32')('automatically releases a Routine Task after its final explicit no-change receipt', async () => {
    await mkdir(join(root, 'wiki'))
    const fixture = await readFile(resolve('../../packages/agent/tests/fixtures/codex-app-server.mjs'), 'utf8')
    await writeFile(join(root, 'codex'), `#!/usr/bin/env node\n${fixture}`, { mode: 0o700 })
    vi.stubEnv('FOLIO_CODEX_EXECUTABLE', join(root, 'codex'))
    const app = runtime()
    try {
      await app.runPromise(
        Effect.gen(function* () {
          const vault = yield* (yield* VaultService).register(join(root, 'wiki'))
          const client = yield* RpcTest.makeClient(TaskRpcs)
          const routineId = uuidv7()
          const saved = yield* client['routines.save']({
            vaultId: vault.id,
            input: {
              id: routineId,
              expectedRevision: null,
              definition: {
                name: 'Inspect only',
                prompt: 'early-completion',
                enabled: true,
                model: null,
                configuration: { agent: 'codex', skillIds: [], integrationIds: [] }
              }
            }
          })
          const result = yield* client['routines.startTask']({
            vaultId: vault.id,
            input: { id: uuidv7(), routineId, expectedRevision: saved.revision }
          })
          yield* Effect.promise(() =>
            vi.waitFor(async () => {
              const detail = await app.runPromise(Effect.flatMap(TaskService, (service) => service.get(vault.id, result.task.id)))
              expect(detail.runs).toMatchObject([{ id: result.run.id, state: 'succeeded', syncState: 'pending' }])
            })
          )
          yield* Effect.promise(() =>
            Promise.all(
              ['native-thread.json', 'skill-roots.json', 'turn-input.json', 'terminal-cleanup.json'].map((name) => rm(join(result.task.worktree, name), { force: true }))
            )
          )
          yield* client['tasks.confirmRunWikiUnchanged']({
            vaultId: vault.id,
            input: { taskId: result.task.id, runId: result.run.id, expectedHead: result.task.worktreeBase! }
          })

          expect((yield* client['tasks.get']({ vaultId: vault.id, id: result.task.id })).task).toMatchObject({
            state: 'completed',
            worktreeState: 'released'
          })
          expect(yield* Effect.promise(() => access(result.task.worktree).then(() => 'exists', (error: NodeJS.ErrnoException) => error.code))).toBe('ENOENT')
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
      )
    } finally {
      await app.dispose()
    }
  }, 20_000)

  it('recovers a settled Routine Task release on a later scheduler tick', async () => {
    await mkdir(join(root, 'wiki'))
    const unavailable = Effect.fail(new AgentRuntimeError({ reason: 'unavailable', message: 'Execution must not start.' }))
    const first = runtime(unavailable)
    let vaultId = ''
    let taskId = ''
    let worktree = ''
    let baseline = ''
    let workspace = ''
    try {
      await first.runPromise(
        Effect.gen(function* () {
          const vault = yield* (yield* VaultService).register(join(root, 'wiki'))
          vaultId = vault.id
          const client = yield* RpcTest.makeClient(TaskRpcs)
          const routineId = uuidv7()
          const saved = yield* client['routines.save']({
            vaultId,
            input: {
              id: routineId,
              expectedRevision: null,
              definition: {
                name: 'Recover completion',
                prompt: 'Inspect',
                enabled: true,
                model: null,
                configuration: { agent: 'codex', skillIds: [], integrationIds: [] }
              }
            }
          })
          const created = yield* client['routines.createTask']({
            vaultId,
            input: { id: uuidv7(), routineId, expectedRevision: saved.revision }
          })
          taskId = created.task.id
          worktree = created.task.worktree
          baseline = created.task.worktreeBase!
          workspace = join(root, 'config/vaults', vaultId, 'workspace')
        }).pipe(Effect.scoped)
      )
    } finally {
      await first.dispose()
    }

    const database = new DatabaseSync(join(root, 'config/vaults', vaultId, 'data.db'))
    const sessionId = uuidv7()
    database.exec('PRAGMA foreign_keys=ON')
    database.prepare(`INSERT INTO sessions
      (id, task_id, agent, adapter_version, purpose, sync_operation_id, acp_session_id, native_session_id, created_at)
      VALUES (?, ?, 'codex', 'fixture', 'task', NULL, ?, NULL, 1)`).run(sessionId, taskId, uuidv7())
    database.prepare(`INSERT INTO runs
      (id, task_id, session_id, prompt, purpose, resumes_run_id, baseline_commit, state, sync_state, created_at, ended_at, error)
      VALUES (?, ?, ?, 'Inspect', 'execution', NULL, ?, 'succeeded', 'not-required', 1, 2, NULL)`).run(uuidv7(), taskId, sessionId, baseline)
    database.prepare("UPDATE tasks SET state='completed', worktree_state='releasing' WHERE id=?").run(taskId)
    database.close()
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* makeVaultGit)(workspace, ['worktree', 'remove', worktree])
      }).pipe(Effect.provide(NodeServices.layer))
    )

    const reopened = runtime(unavailable)
    try {
      await reopened.runPromise(Effect.flatMap(TaskService, (service) => service.tickSchedules(vaultId)))
      await reopened.runPromise(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(TaskRpcs)
          expect((yield* client['tasks.get']({ vaultId, id: taskId })).task).toMatchObject({ state: 'completed', worktreeState: 'released' })
        }).pipe(Effect.scoped)
      )
      await expect(access(worktree)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await reopened.dispose()
    }
  }, 15_000)

  it('retains a Routine Task when its latest Run failed, then releases it after a later successful recovery', async () => {
    await mkdir(join(root, 'wiki'))
    const unavailable = Effect.fail(new AgentRuntimeError({ reason: 'unavailable', message: 'Execution must not start.' }))
    const app = runtime(unavailable)
    try {
      await app.runPromise(
        Effect.gen(function* () {
          const vault = yield* (yield* VaultService).register(join(root, 'wiki'))
          const client = yield* RpcTest.makeClient(TaskRpcs)
          const routineId = uuidv7()
          const saved = yield* client['routines.save']({
            vaultId: vault.id,
            input: {
              id: routineId,
              expectedRevision: null,
              definition: {
                name: 'Recover failure',
                prompt: 'Inspect',
                enabled: true,
                model: null,
                configuration: { agent: 'codex', skillIds: [], integrationIds: [] }
              }
            }
          })
          const created = yield* client['routines.createTask']({
            vaultId: vault.id,
            input: { id: uuidv7(), routineId, expectedRevision: saved.revision }
          })
          const sessionId = uuidv7()
          const succeededId = 'z-succeeded-first'
          const failedId = 'a-failed-second'
          yield* Effect.sync(() => {
            const database = new DatabaseSync(join(root, 'config/vaults', vault.id, 'data.db'))
            try {
              database.exec('PRAGMA foreign_keys=ON')
              database.prepare(`INSERT INTO sessions
                (id, task_id, agent, adapter_version, purpose, sync_operation_id, acp_session_id, native_session_id, created_at)
                VALUES (?, ?, 'codex', 'fixture', 'task', NULL, ?, NULL, 1)`).run(sessionId, created.task.id, uuidv7())
              const insert = database.prepare(`INSERT INTO runs
                (id, task_id, session_id, prompt, purpose, resumes_run_id, baseline_commit, state, sync_state, created_at, ended_at, error)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              // Same wall-clock time and reverse lexical IDs prove completion uses insertion order.
              insert.run(succeededId, created.task.id, sessionId, 'First', 'execution', null, created.task.worktreeBase, 'succeeded', 'not-required', 100, 101, null)
              insert.run(failedId, created.task.id, sessionId, 'Retry', 'recovery', succeededId, created.task.worktreeBase, 'failed', 'pending', 100, 102, 'fixture')
            } finally {
              database.close()
            }
          })

          yield* Effect.flatMap(TaskService, (service) => service.tickSchedules(vault.id))
          expect((yield* client['tasks.get']({ vaultId: vault.id, id: created.task.id })).task).toMatchObject({ state: 'active', worktreeState: 'ready' })
          expect(yield* Effect.promise(() => access(created.task.worktree).then(() => 'exists'))).toBe('exists')

          yield* Effect.sync(() => {
            const database = new DatabaseSync(join(root, 'config/vaults', vault.id, 'data.db'))
            try {
              database.exec('PRAGMA foreign_keys=ON')
              database.prepare(`INSERT INTO runs
                (id, task_id, session_id, prompt, purpose, resumes_run_id, baseline_commit, state, sync_state, created_at, ended_at, error)
                VALUES ('0-recovered-third', ?, ?, 'Recovered', 'recovery', ?, ?, 'succeeded', 'not-required', 50, 103, NULL)`)
                .run(created.task.id, sessionId, failedId, created.task.worktreeBase)
            } finally {
              database.close()
            }
          })
          yield* Effect.flatMap(TaskService, (service) => service.tickSchedules(vault.id))
          expect((yield* client['tasks.get']({ vaultId: vault.id, id: created.task.id })).task).toMatchObject({ state: 'completed', worktreeState: 'released' })
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
      )
    } finally {
      await app.dispose()
    }
  }, 15_000)

  it('returns a no-change receipt when Routine cleanup is blocked and releases on a later tick', async () => {
    await mkdir(join(root, 'wiki'))
    const unavailable = Effect.fail(new AgentRuntimeError({ reason: 'unavailable', message: 'Execution must not start.' }))
    const app = runtime(unavailable)
    try {
      await app.runPromise(
        Effect.gen(function* () {
          const vault = yield* (yield* VaultService).register(join(root, 'wiki'))
          const client = yield* RpcTest.makeClient(TaskRpcs)
          const routineId = uuidv7()
          const saved = yield* client['routines.save']({
            vaultId: vault.id,
            input: {
              id: routineId,
              expectedRevision: null,
              definition: {
                name: 'Retain cleanup receipt',
                prompt: 'Inspect',
                enabled: true,
                model: null,
                configuration: { agent: 'codex', skillIds: [], integrationIds: [] }
              }
            }
          })
          const created = yield* client['routines.createTask']({
            vaultId: vault.id,
            input: { id: uuidv7(), routineId, expectedRevision: saved.revision }
          })
          const sessionId = uuidv7()
          const runId = uuidv7()
          yield* Effect.sync(() => {
            const database = new DatabaseSync(join(root, 'config/vaults', vault.id, 'data.db'))
            try {
              database.exec('PRAGMA foreign_keys=ON')
              database.prepare(`INSERT INTO sessions
                (id, task_id, agent, adapter_version, purpose, sync_operation_id, acp_session_id, native_session_id, created_at)
                VALUES (?, ?, 'codex', 'fixture', 'task', NULL, ?, NULL, 1)`).run(sessionId, created.task.id, uuidv7())
              database.prepare(`INSERT INTO runs
                (id, task_id, session_id, prompt, purpose, resumes_run_id, baseline_commit, state, sync_state, created_at, ended_at, error)
                VALUES (?, ?, ?, 'Inspect', 'execution', NULL, ?, 'succeeded', 'pending', 1, 2, NULL)`)
                .run(runId, created.task.id, sessionId, created.task.worktreeBase)
            } finally {
              database.close()
            }
          })
          const retained = join(created.task.worktree, 'inspection.tmp')
          yield* Effect.promise(() => writeFile(retained, 'keep'))
          const receipt = yield* client['tasks.confirmRunWikiUnchanged']({
            vaultId: vault.id,
            input: { taskId: created.task.id, runId, expectedHead: created.task.worktreeBase! }
          })

          expect(receipt).toMatchObject({ id: runId, syncState: 'not-required' })
          expect((yield* client['tasks.get']({ vaultId: vault.id, id: created.task.id })).task).toMatchObject({ state: 'active', worktreeState: 'ready' })
          yield* Effect.promise(() => rm(retained))
          yield* Effect.flatMap(TaskService, (service) => service.tickSchedules(vault.id))
          expect((yield* client['tasks.get']({ vaultId: vault.id, id: created.task.id })).task).toMatchObject({ state: 'completed', worktreeState: 'released' })
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
      )
    } finally {
      await app.dispose()
    }
  }, 15_000)

  it.skipIf(process.platform === 'win32')('does not close a live inspection Session during Routine cleanup retries', async () => {
    await mkdir(join(root, 'wiki'))
    const fixture = (await readFile(resolve('../../packages/agent/tests/fixtures/codex-app-server.mjs'), 'utf8')).replace(
      'if (method === "initialize") return send({ id, result: { userAgent: "fixture" } });',
      'if (method === "initialize") { writeFileSync("native-pid", String(process.pid)); return send({ id, result: { userAgent: "fixture" } }); }'
    )
    await writeFile(join(root, 'codex'), `#!/usr/bin/env node\n${fixture}`, { mode: 0o700 })
    vi.stubEnv('FOLIO_CODEX_EXECUTABLE', join(root, 'codex'))
    const app = runtime()
    let nativePid = 0
    try {
      await app.runPromise(
        Effect.gen(function* () {
          const vault = yield* (yield* VaultService).register(join(root, 'wiki'))
          const client = yield* RpcTest.makeClient(TaskRpcs)
          const routineId = uuidv7()
          const saved = yield* client['routines.save']({
            vaultId: vault.id,
            input: {
              id: routineId,
              expectedRevision: null,
              definition: {
                name: 'Inspect retained Task',
                prompt: 'Inspect',
                enabled: true,
                model: null,
                configuration: { agent: 'codex', skillIds: [], integrationIds: [] }
              }
            }
          })
          const created = yield* client['routines.createTask']({
            vaultId: vault.id,
            input: { id: uuidv7(), routineId, expectedRevision: saved.revision }
          })
          const sessionId = uuidv7()
          yield* client['tasks.openSession']({ vaultId: vault.id, taskId: created.task.id, sessionId, agent: 'codex' })
          nativePid = Number(yield* Effect.promise(() => readFile(join(created.task.worktree, 'native-pid'), 'utf8')))
          yield* Effect.sync(() => {
            const database = new DatabaseSync(join(root, 'config/vaults', vault.id, 'data.db'))
            try {
              database.exec('PRAGMA foreign_keys=ON')
              database.prepare(`INSERT INTO runs
                (id, task_id, session_id, prompt, purpose, resumes_run_id, baseline_commit, state, sync_state, created_at, ended_at, error)
                VALUES (?, ?, ?, 'Inspect', 'execution', NULL, ?, 'succeeded', 'not-required', 1, 2, NULL)`)
                .run(uuidv7(), created.task.id, sessionId, created.task.worktreeBase)
            } finally {
              database.close()
            }
          })

          yield* Effect.flatMap(TaskService, (service) => service.tickSchedules(vault.id))
          expect((yield* client['tasks.get']({ vaultId: vault.id, id: created.task.id })).task).toMatchObject({ state: 'active', worktreeState: 'ready' })
          expect(() => process.kill(nativePid, 0)).not.toThrow()

          yield* client['tasks.closeSession']({ vaultId: vault.id, taskId: created.task.id, sessionId })
          expect(() => process.kill(nativePid, 0)).toThrow()
          yield* Effect.promise(() =>
            Promise.all(['native-pid', 'native-thread.json', 'skill-roots.json', 'terminal-cleanup.json'].map((name) => rm(join(created.task.worktree, name), { force: true })))
          )
          expect(yield* client['tasks.complete']({ vaultId: vault.id, taskId: created.task.id })).toMatchObject({
            state: 'completed',
            worktreeState: 'released'
          })
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
      )
    } finally {
      await app.dispose()
    }
  }, 15_000)

  it.skipIf(process.platform === 'win32')('serializes Session startup with Task completion before releasing the worktree', async () => {
    await mkdir(join(root, 'wiki'))
    let fixture = await readFile(resolve('../../packages/agent/tests/fixtures/codex-app-server.mjs'), 'utf8')
    fixture = fixture.replace('readFileSync, writeFileSync', 'readFileSync, writeFileSync, existsSync')
    fixture = fixture.replace(
      'if (method === "initialize") return send({ id, result: { userAgent: "fixture" } });',
      'if (method === "initialize") { writeFileSync("initializing", String(process.pid)); const timer = setInterval(() => { if (existsSync("block-startup")) return; clearInterval(timer); send({ id, result: { userAgent: "fixture" } }); }, 10); timer.unref(); return; }'
    )
    await writeFile(join(root, 'codex'), `#!/usr/bin/env node\n${fixture}`, { mode: 0o700 })
    vi.stubEnv('FOLIO_CODEX_EXECUTABLE', join(root, 'codex'))
    const app = runtime()
    let vaultId = ''
    let taskId = ''
    let worktree = ''
    const sessionId = uuidv7()
    let nativePid = 0
    try {
      await app.runPromise(
        Effect.gen(function* () {
          const vault = yield* (yield* VaultService).register(join(root, 'wiki'))
          vaultId = vault.id
          taskId = uuidv7()
          const client = yield* RpcTest.makeClient(TaskRpcs)
          worktree = (yield* client['tasks.create']({ vaultId, id: taskId, goal: 'Race startup and completion', agent: 'codex' })).worktree
        }).pipe(Effect.scoped)
      )
      await writeFile(join(worktree, 'block-startup'), '')
      const opening = app.runFork(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(TaskRpcs)
          return yield* client['tasks.openSession']({ vaultId, taskId, sessionId, agent: 'codex' })
        }).pipe(Effect.scoped)
      )
      await vi.waitFor(async () => {
        nativePid = Number(await readFile(join(worktree, 'initializing'), 'utf8').catch(() => ''))
        expect(nativePid).toBeGreaterThan(0)
      }, { timeout: 5000 })
      const completion = app.runFork(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(TaskRpcs)
          return yield* client['tasks.complete']({ vaultId, taskId })
        }).pipe(Effect.scoped)
      )

      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
      expect((await app.runPromise(Effect.flatMap(TaskService, (service) => service.get(vaultId, taskId)))).task).toMatchObject({
        state: 'active',
        worktreeState: 'ready'
      })
      expect(() => process.kill(nativePid, 0)).not.toThrow()

      await rm(join(worktree, 'block-startup'))
      expect(await app.runPromise(Fiber.join(opening))).toMatchObject({ id: sessionId })
      expect((await app.runPromise(Fiber.await(completion)))._tag).toBe('Failure')
      expect(() => process.kill(nativePid, 0)).toThrow()
      await Promise.all(['initializing', 'native-thread.json', 'skill-roots.json', 'terminal-cleanup.json'].map((name) => rm(join(worktree, name), { force: true })))
      expect(
        await app.runPromise(
          Effect.gen(function* () {
            const client = yield* RpcTest.makeClient(TaskRpcs)
            return yield* client['tasks.complete']({ vaultId, taskId })
          }).pipe(Effect.scoped)
        )
      ).toMatchObject({ state: 'completed', worktreeState: 'released' })
    } finally {
      await app.dispose()
    }
  }, 15_000)

  it('automatically releases a Routine Task after its saved wiki output is aligned', async () => {
    await mkdir(join(root, 'wiki'))
    const unavailable = Effect.fail(new AgentRuntimeError({ reason: 'unavailable', message: 'Execution must not start.' }))
    const app = runtime(unavailable)
    try {
      await app.runPromise(
        Effect.gen(function* () {
          const vault = yield* (yield* VaultService).register(join(root, 'wiki'))
          const client = yield* RpcTest.makeClient(TaskRpcs)
          const routineId = uuidv7()
          const savedRoutine = yield* client['routines.save']({
            vaultId: vault.id,
            input: {
              id: routineId,
              expectedRevision: null,
              definition: {
                name: 'Write output',
                prompt: 'Write',
                enabled: true,
                model: null,
                configuration: { agent: 'codex', skillIds: [], integrationIds: [] }
              }
            }
          })
          const created = yield* client['routines.createTask']({
            vaultId: vault.id,
            input: { id: uuidv7(), routineId, expectedRevision: savedRoutine.revision }
          })
          const sessionId = uuidv7()
          const runId = uuidv7()
          yield* Effect.sync(() => {
            const database = new DatabaseSync(join(root, 'config/vaults', vault.id, 'data.db'))
            try {
              database.exec('PRAGMA foreign_keys=ON')
              database.prepare(`INSERT INTO sessions
                (id, task_id, agent, adapter_version, purpose, sync_operation_id, acp_session_id, native_session_id, created_at)
                VALUES (?, ?, 'codex', 'fixture', 'task', NULL, ?, NULL, 1)`).run(sessionId, created.task.id, uuidv7())
              database.prepare(`INSERT INTO runs
                (id, task_id, session_id, prompt, purpose, resumes_run_id, baseline_commit, state, sync_state, created_at, ended_at, error)
                VALUES (?, ?, ?, 'Write', 'execution', NULL, ?, 'succeeded', 'pending', 1, 2, NULL)`).run(
                runId,
                created.task.id,
                sessionId,
                created.task.worktreeBase
              )
            } finally {
              database.close()
            }
          })
          yield* Effect.promise(() => writeFile(join(created.task.worktree, 'wiki/routine.md'), 'Routine output\n'))
          const saved = yield* client['tasks.saveRunWikiFiles']({
            vaultId: vault.id,
            input: { id: uuidv7(), taskId: created.task.id, runIds: [runId], expectedParent: created.task.worktreeBase!, paths: ['wiki/routine.md'] }
          })
          const synchronized = yield* client['tasks.synchronizeWiki']({
            vaultId: vault.id,
            input: { id: uuidv7(), taskId: created.task.id, expectedSourceHead: saved.commit }
          })

          expect(synchronized.state).toBe('aligned')
          expect((yield* client['tasks.get']({ vaultId: vault.id, id: created.task.id })).task).toMatchObject({ state: 'completed', worktreeState: 'released' })
          const git = yield* makeVaultGit
          expect(yield* git(join(root, 'config/vaults', vault.id, 'workspace'), ['show', 'HEAD:wiki/routine.md'])).toBe('Routine output\n')
          expect(yield* Effect.promise(() => access(created.task.worktree).then(() => 'exists', (error: NodeJS.ErrnoException) => error.code))).toBe('ENOENT')
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
      )
    } finally {
      await app.dispose()
    }
  }, 15_000)

  it('resolves and aborts Task wiki conflicts through stable RPC receipts without starting an Agent', async () => {
    await mkdir(join(root, 'wiki'))
    const probe = vi.fn()
    const unavailable = Effect.sync(probe).pipe(Effect.andThen(Effect.fail(new AgentRuntimeError({ reason: 'unavailable', message: 'fixture' }))))
    const app = runtime(unavailable)
    try {
      await app.runPromise(
        Effect.gen(function* () {
          const vault = yield* (yield* VaultService).register(join(root, 'wiki'))
          const client = yield* RpcTest.makeClient(TaskRpcs)
          const taskId = uuidv7()
          const task = yield* client['tasks.create']({ vaultId: vault.id, id: taskId, goal: 'Retain a conflict', agent: 'codex', integrationIds: [] })
          const workspace = join(root, 'config/vaults', vault.id, 'workspace')
          yield* Effect.promise(async () => {
            await writeFile(join(workspace, 'wiki/conflict.md'), 'main version\n')
            await writeFile(join(task.worktree, 'wiki/conflict.md'), 'Task version\n')
          })
          const mainSave = yield* client['workspace.saveFiles']({
            vaultId: vault.id,
            input: { id: uuidv7(), expectedParent: task.worktreeBase!, paths: ['wiki/conflict.md'] }
          })
          expect(mainSave.state).toBe('applied')
          const taskSave = yield* client['tasks.saveWikiFiles']({
            vaultId: vault.id,
            input: { id: uuidv7(), taskId, expectedParent: task.worktreeBase!, paths: ['wiki/conflict.md'] }
          })
          const conflicted = yield* client['tasks.synchronizeWiki']({
            vaultId: vault.id,
            input: { id: uuidv7(), taskId, expectedSourceHead: taskSave.commit }
          })
          expect(conflicted).toMatchObject({ taskId, state: 'conflict', supersedesId: null })
          expect(yield* client['tasks.pendingSynchronizations']({ vaultId: vault.id, taskId })).toEqual([conflicted])
          expect(yield* client['tasks.pendingSynchronizations']({ vaultId: vault.id, taskId: uuidv7() }).pipe(Effect.flip)).toMatchObject({ reason: 'not-found' })
          expect(
            yield* client['tasks.reprepareWiki']({ vaultId: vault.id, input: { id: uuidv7(), taskId: uuidv7(), supersededId: conflicted.id } }).pipe(Effect.flip)
          ).toMatchObject({ reason: 'not-found' })

          const git = yield* makeVaultGit
          const coordinator = join(root, 'config/vaults', vault.id, 'sync-worktrees', conflicted.id)
          yield* Effect.promise(() => writeFile(join(coordinator, 'wiki/conflict.md'), 'main version\nTask version\n'))
          yield* git(coordinator, ['add', '--', 'wiki/conflict.md'])
          expect(
            yield* client['tasks.resolveWikiConflict']({ vaultId: vault.id, taskId: uuidv7(), id: conflicted.id }).pipe(Effect.flip)
          ).toMatchObject({ reason: 'not-found' })
          const resolved = yield* client['tasks.resolveWikiConflict']({ vaultId: vault.id, taskId, id: conflicted.id })
          expect(resolved).toMatchObject({ id: conflicted.id, taskId, state: 'aligned' })
          expect(yield* client['tasks.resolveWikiConflict']({ vaultId: vault.id, taskId, id: conflicted.id })).toEqual(resolved)
          expect(yield* git(workspace, ['show', 'HEAD:wiki/conflict.md'])).toBe('main version\nTask version\n')

          const mainHead = (yield* git(workspace, ['rev-parse', 'HEAD'])).trim()
          const taskHead = (yield* git(task.worktree, ['rev-parse', 'HEAD'])).trim()
          yield* Effect.promise(async () => {
            await writeFile(join(workspace, 'wiki/abort.md'), 'main abort\n')
            await writeFile(join(task.worktree, 'wiki/abort.md'), 'Task abort\n')
          })
          yield* client['workspace.saveFiles']({
            vaultId: vault.id,
            input: { id: uuidv7(), expectedParent: mainHead, paths: ['wiki/abort.md'] }
          })
          const abortSource = yield* client['tasks.saveWikiFiles']({
            vaultId: vault.id,
            input: { id: uuidv7(), taskId, expectedParent: taskHead, paths: ['wiki/abort.md'] }
          })
          const abortConflict = yield* client['tasks.synchronizeWiki']({
            vaultId: vault.id,
            input: { id: uuidv7(), taskId, expectedSourceHead: abortSource.commit }
          })
          expect(abortConflict.state).toBe('conflict')
          const aborted = yield* client['tasks.abortWikiConflict']({ vaultId: vault.id, taskId, id: abortConflict.id })
          expect(aborted.state).toBe('aborted')
          expect(yield* client['tasks.abortWikiConflict']({ vaultId: vault.id, taskId, id: abortConflict.id })).toEqual(aborted)
          expect(yield* client['tasks.pendingSynchronizations']({ vaultId: vault.id, taskId })).toEqual([])
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
      )
      expect(probe).not.toHaveBeenCalled()
    } finally {
      await app.dispose()
    }
  }, 30_000)

  it('persists daily settings through RPC while Agent runtime is unavailable', async () => {
    await mkdir(join(root, 'wiki'))
    const app = runtime(Effect.fail(new AgentRuntimeError({ reason: 'unavailable', message: 'fixture' })))
    let vaultId = ''
    const routineId = uuidv7()
    try {
      await app.runPromise(
        Effect.gen(function* () {
          vaultId = (yield* (yield* VaultService).register(join(root, 'wiki'))).id
          const client = yield* RpcTest.makeClient(TaskRpcs)
          expect(yield* client['routines.scheduleSettings']({ vaultId })).toEqual({ timeZone: null, schedules: [] })
          yield* client['routines.save']({
            vaultId,
            input: {
              id: routineId,
              expectedRevision: null,
              definition: { name: 'Daily', prompt: 'Fixture', enabled: true, model: null, configuration: { agent: 'codex', skillIds: [], integrationIds: [] } }
            }
          })
          yield* client['routines.setTimeZone']({ vaultId, timeZone: 'Asia/Shanghai', expected: null })
          const input = { routineId, time: '09:30', expectedRevision: null }
          const first = yield* client['routines.saveSchedule']({ vaultId, input })
          expect(yield* client['routines.saveSchedule']({ vaultId, input })).toEqual(first)
          expect(yield* client['routines.setTimeZone']({ vaultId, timeZone: 'UTC', expected: null }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
          expect(yield* client['tasks.list']({ vaultId })).toEqual([])
        }).pipe(Effect.scoped)
      )
    } finally {
      await app.dispose()
    }
    const reopened = runtime()
    try {
      await reopened.runPromise(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(TaskRpcs)
          expect(yield* client['routines.scheduleSettings']({ vaultId })).toMatchObject({ timeZone: 'Asia/Shanghai', schedules: [{ routineId, time: '09:30', revision: 1 }] })
          expect(yield* client['routines.removeSchedule']({ vaultId, routineId, revision: 2 }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
          yield* client['routines.removeSchedule']({ vaultId, routineId, revision: 1 })
          expect(yield* client['routines.scheduleSettings']({ vaultId })).toEqual({ timeZone: 'Asia/Shanghai', schedules: [] })
          expect(yield* client['routines.scheduleSettings']({ vaultId: uuidv7() }).pipe(Effect.flip)).toMatchObject({ reason: 'not-found' })
          expect(yield* client['tasks.list']({ vaultId })).toEqual([])
        }).pipe(Effect.scoped)
      )
    } finally {
      await reopened.dispose()
    }
  })

  it('reads pending occurrences over RPC after restart without preparing Tasks or starting an Agent', async () => {
    await mkdir(join(root, 'wiki'))
    await mkdir(join(root, 'other-wiki'))
    const probe = vi.fn()
    const unavailable = Effect.sync(probe).pipe(Effect.andThen(Effect.fail(new AgentRuntimeError({ reason: 'unavailable', message: 'unavailable' }))))
    const app = runtime(unavailable)
    let firstVault = ''
    let secondVault = ''
    const routineId = uuidv7()
    try {
      await app.runPromise(
        Effect.gen(function* () {
          const vaults = yield* VaultService
          firstVault = (yield* vaults.register(join(root, 'wiki'))).id
          secondVault = (yield* vaults.register(join(root, 'other-wiki'))).id
          const tasks = yield* TaskService
          for (const vaultId of [firstVault, secondVault])
            yield* tasks.saveRoutine(vaultId, {
              id: routineId,
              expectedRevision: null,
              definition: { name: 'Queue', prompt: 'Fixture', enabled: true, model: null, configuration: { agent: 'codex', integrationIds: [], skillIds: [] } }
            })
          for (const triggeredAt of [100, 200]) yield* tasks.enqueueRoutine(firstVault, { id: uuidv7(), routineId, triggeredAt })
        })
      )
    } finally {
      await app.dispose()
    }
    const reopened = runtime(unavailable)
    try {
      await reopened.runPromise(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(TaskRpcs)
          const result = yield* client['routines.wakeups']({ vaultId: firstVault, routineId })
          expect(result.map((value) => value.triggeredAt)).toEqual([100, 200])
          expect(result.every((value) => value.triggerId === null)).toBe(true)
          expect(yield* client['routines.wakeups']({ vaultId: secondVault, routineId })).toEqual([])
          expect(yield* client['routines.wakeups']({ vaultId: uuidv7(), routineId }).pipe(Effect.flip)).toMatchObject({ reason: 'not-found' })
          expect(yield* client['routines.triggers']({ vaultId: firstVault, routineId })).toEqual([])
          expect(yield* client['tasks.list']({ vaultId: firstVault })).toEqual([])
        }).pipe(Effect.scoped)
      )
      expect(probe).not.toHaveBeenCalled()
    } finally {
      await reopened.dispose()
    }
  })

  it.skipIf(process.platform === 'win32')(
    'dispatches one coalesced batch with the latest definition after the prior Routine run stops',
    async () => {
      await mkdir(join(root, 'wiki'))
      const fixture = (await readFile(resolve('../../packages/agent/tests/fixtures/codex-app-server.mjs'), 'utf8'))
        .replace('id: "native-thread", cwd:', 'id: process.cwd(), cwd:')
        .replace('import { readFileSync, writeFileSync }', 'import { appendFileSync, readFileSync, writeFileSync }')
        .replace(
          "writeFileSync('turn-input.json', JSON.stringify(params.input));",
          "appendFileSync('dispatches.log', params.input[0].text + '\\n'); writeFileSync('turn-input.json', JSON.stringify(params.input));"
        )
      await writeFile(join(root, 'codex'), `#!/usr/bin/env node\n${fixture}`, { mode: 0o700 })
      vi.stubEnv('FOLIO_CODEX_EXECUTABLE', join(root, 'codex'))
      const app = runtime()
      try {
        await app.runPromise(
          Effect.gen(function* () {
            const vault = yield* (yield* VaultService).register(join(root, 'wiki'))
            const tasks = yield* TaskService
            const routine = yield* tasks.saveRoutine(vault.id, {
              id: uuidv7(),
              expectedRevision: null,
              definition: { name: 'Queued', prompt: 'running', enabled: true, model: null, configuration: { agent: 'codex', skillIds: [], integrationIds: [] } }
            })
            const first = yield* tasks.startRoutineTask(vault.id, { id: uuidv7(), routineId: routine.id, expectedRevision: 1 })
            yield* Effect.promise(() =>
              vi.waitFor(
                async () => {
                  expect((await app.runPromise(tasks.get(vault.id, first.task.id))).runs[0]?.state).toBe('running')
                },
                { timeout: 5000 }
              )
            )
            for (const triggeredAt of [100, 200, 300]) {
              const input = { id: uuidv7(), routineId: routine.id, triggeredAt }
              yield* tasks.enqueueRoutine(vault.id, input)
              yield* tasks.enqueueRoutine(vault.id, input)
            }
            yield* tasks.setScheduleTimeZone(vault.id, 'UTC', null)
            yield* tasks.saveSchedule(vault.id, { routineId: routine.id, time: '09:00', expectedRevision: null })
            yield* Effect.sync(() => {
              const db = new DatabaseSync(join(root, 'config', 'vaults', vault.id, 'data.db'))
              try {
                db.prepare('UPDATE routine_schedules SET next_at=? WHERE routine_id=?').run(Date.now() - 2 * 86400000, routine.id)
              } finally {
                db.close()
              }
            })
            yield* tasks.tickSchedules(vault.id)
            expect(yield* tasks.dispatchPendingRoutine(vault.id, routine.id)).toBeNull()
            expect(yield* tasks.list(vault.id)).toHaveLength(1)
            yield* tasks.saveRoutine(vault.id, { id: routine.id, expectedRevision: 1, definition: { ...routine.definition, prompt: 'early-completion' } })
            yield* tasks.cancelRun(vault.id, first.task.id, first.run.id)
            yield* tasks.tickSchedules(vault.id)
            const [accepted] = (yield* tasks.routineTriggers(vault.id, routine.id)).filter((trigger) => trigger.id !== first.trigger.id)
            const next = yield* tasks.startRoutineTask(vault.id, { id: accepted!.id, routineId: routine.id, expectedRevision: accepted!.expectedRevision })
            expect(next.trigger.snapshot.definition.prompt).toBe('early-completion')
            yield* tasks.tickSchedules(vault.id)
            yield* Effect.promise(() =>
              vi.waitFor(
                async () => {
                  expect(await readFile(join(next.task.worktree, 'dispatches.log'), 'utf8')).toBe('early-completion\n')
                },
                { timeout: 5000 }
              )
            )
            expect(yield* tasks.list(vault.id)).toHaveLength(2)
            const wakeups = yield* tasks.routineWakeups(vault.id, routine.id)
            expect(wakeups.slice(0, 3).map((value) => value.triggeredAt)).toEqual([100, 200, 300])
            expect(wakeups.length).toBeGreaterThan(3)
            expect(new Set(wakeups.map((value) => value.triggerId))).toEqual(new Set([next.trigger.id]))
            expect(yield* tasks.dispatchPendingRoutine(vault.id, routine.id)).toBeNull()
          })
        )
      } finally {
        await app.dispose()
      }
    },
    15000
  )

  it.skipIf(process.platform === 'win32').each(['interrupted', 'preparing'] as const)(
    'dispatches a Routine once across concurrent requests, edits and restart (%s)',
    async (persistedState) => {
      await mkdir(join(root, 'wiki'))
      const fixture = (await readFile(resolve('../../packages/agent/tests/fixtures/codex-app-server.mjs'), 'utf8'))
        .replace('import { readFileSync, writeFileSync }', 'import { appendFileSync, readFileSync, writeFileSync }')
        .replace(
          "writeFileSync('turn-input.json', JSON.stringify(params.input));",
          "appendFileSync('dispatches.log', params.input[0].text + '\\n'); writeFileSync('turn-input.json', JSON.stringify(params.input));"
        )
      await writeFile(join(root, 'codex'), `#!/usr/bin/env node\n${fixture}`, { mode: 0o700 })
      vi.stubEnv('FOLIO_CODEX_EXECUTABLE', join(root, 'codex'))
      const app = runtime()
      const saved = await app
        .runPromise(
          Effect.gen(function* () {
            const vault = yield* (yield* VaultService).register(join(root, 'wiki'))
            const client = yield* RpcTest.makeClient(TaskRpcs)
            const routine = yield* client['routines.save']({
              vaultId: vault.id,
              input: {
                id: uuidv7(),
                expectedRevision: null,
                definition: { name: 'Run once', prompt: 'running', enabled: true, model: null, configuration: { agent: 'codex', skillIds: [], integrationIds: [] } }
              }
            })
            const input = { id: uuidv7(), routineId: routine.id, expectedRevision: 1 }
            const [first, second] = yield* Effect.all([client['routines.startTask']({ vaultId: vault.id, input }), client['routines.startTask']({ vaultId: vault.id, input })], {
              concurrency: 'unbounded'
            })
            expect(second.execution).toEqual(first.execution)
            expect(second.run.id).toBe(first.run.id)
            // A Run reservation can precede native dispatch. Confirm the native acknowledgement
            // before shutdown so this probe actually covers a sent Prompt, rather than only intent.
            let running = false
            for (let attempt = 0; attempt < 100; attempt++) {
              const detail = yield* client['tasks.get']({ vaultId: vault.id, id: first.task.id })
              if (detail.runs.some((run) => run.id === first.run.id && run.state === 'running')) {
                running = true
                break
              }
              yield* Effect.sleep('20 millis')
            }
            expect(running).toBe(true)
            yield* client['routines.save']({
              vaultId: vault.id,
              input: { id: routine.id, expectedRevision: 1, definition: { ...routine.definition, enabled: false, prompt: 'must-not-replay' } }
            })
            expect((yield* client['routines.startTask']({ vaultId: vault.id, input })).run.id).toBe(first.run.id)
            return { vaultId: vault.id, input, first }
          }).pipe(Effect.scoped)
        )
        .finally(() => app.dispose())
      if (persistedState === 'preparing') {
        // Simulate a missing acknowledgement/cleanup receipt after the native Prompt was sent.
        const db = new DatabaseSync(join(root, 'config/vaults', saved.vaultId, 'data.db'))
        try {
          db.prepare("UPDATE runs SET state='preparing', ended_at=NULL WHERE id=?").run(saved.first.run.id)
        } finally {
          db.close()
        }
      }
      const reopened = runtime(Effect.fail(new AgentRuntimeError({ reason: 'unavailable', message: 'Must not restart Agent' })))
      try {
        await reopened.runPromise(
          Effect.gen(function* () {
            const client = yield* RpcTest.makeClient(TaskRpcs)
            const result = yield* client['routines.startTask']({ vaultId: saved.vaultId, input: saved.input })
            expect(result.execution).toEqual(saved.first.execution)
            expect(result.run).toMatchObject({ id: saved.first.run.id, state: persistedState, prompt: 'running' })
            const detail = yield* client['tasks.get']({ vaultId: saved.vaultId, id: result.task.id })
            expect(detail.sessions).toHaveLength(1)
            expect(detail.runs).toHaveLength(1)
            expect(yield* Effect.promise(() => readFile(join(result.task.worktree, 'dispatches.log'), 'utf8'))).toBe('running\n')
          }).pipe(Effect.scoped)
        )
      } finally {
        await reopened.dispose()
      }
    }
  )

  it('pins the Pi model before startup failure and rejects a different Agent Session on the Task', async () => {
    await mkdir(join(root, 'wiki'))
    const app = runtime(Effect.succeed({ nodeExecutable: '/missing-folio-node', entrypoint: resolve('../../packages/agent/dist/cli.js'), agentVersion: 'fixture' }))
    try {
      await app.runPromise(
        Effect.gen(function* () {
          const vault = yield* (yield* VaultService).register(join(root, 'wiki'))
          const client = yield* RpcTest.makeClient(TaskRpcs)
          const models = yield* ModelService
          const selected = (yield* models.listCatalog).models.find((model) => model.providerId === 'anthropic' && model.source === 'builtin')!
          yield* models.setProviderCredential(selected.providerId, Redacted.make('fixture-no-model-request'))
          const model = { providerId: selected.providerId, modelId: selected.modelId, thinkingLevel: 'off' as const }
          const routine = yield* client['routines.save']({
            vaultId: vault.id,
            input: {
              id: uuidv7(),
              expectedRevision: null,
              definition: { name: 'Pi snapshot', prompt: 'Never dispatched', enabled: true, model, configuration: { agent: 'pi', skillIds: [], integrationIds: [] } }
            }
          })
          const input = { id: uuidv7(), routineId: routine.id, expectedRevision: 1 }
          expect(yield* client['routines.startTask']({ vaultId: vault.id, input }).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
          const [{ taskId }] = yield* client['routines.triggers']({ vaultId: vault.id, routineId: routine.id })
          const original = yield* client['tasks.get']({ vaultId: vault.id, id: taskId })
          expect(original.runs).toEqual([])
          expect(original.sessions).toHaveLength(1)
          expect(original.sessions[0]!.modelProfile).toMatchObject({ modelId: model.modelId, thinkingLevel: 'off', provider: { providerId: model.providerId } })
          expect(yield* client['routines.startTask']({ vaultId: vault.id, input }).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
          expect((yield* client['tasks.get']({ vaultId: vault.id, id: taskId })).sessions).toEqual(original.sessions)
          // Task Agent is immutable in V1; a new Session cannot be used as a switching mechanism.
          expect(yield* client['tasks.openSession']({ vaultId: vault.id, taskId, sessionId: uuidv7(), agent: 'codex' }).pipe(Effect.flip)).toMatchObject({
            reason: 'invalid-state'
          })
          expect(yield* client['routines.startTask']({ vaultId: vault.id, input }).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
          expect((yield* client['tasks.get']({ vaultId: vault.id, id: taskId })).runs).toEqual([])
        }).pipe(Effect.scoped)
      )
    } finally {
      await app.dispose()
    }
  })

  it.skipIf(process.platform === 'win32')('rejects a sibling Routine Prompt before native dispatch and permits retry after cancellation', async () => {
    await mkdir(join(root, 'wiki'))
    const fixture = (await readFile(resolve('../../packages/agent/tests/fixtures/codex-app-server.mjs'), 'utf8'))
      // Each Task owns an independent native thread; the shared fixture otherwise uses a constant ID.
      .replace('id: "native-thread", cwd:', 'id: process.cwd(), cwd:')
    await writeFile(join(root, 'codex'), `#!/usr/bin/env node\n${fixture}`, { mode: 0o700 })
    vi.stubEnv('FOLIO_CODEX_EXECUTABLE', join(root, 'codex'))
    const app = runtime()
    try {
      await app.runPromise(
        Effect.gen(function* () {
          const vault = yield* (yield* VaultService).register(join(root, 'wiki'))
          const client = yield* RpcTest.makeClient(TaskRpcs)
          const routine = yield* client['routines.save']({
            vaultId: vault.id,
            input: {
              id: uuidv7(),
              expectedRevision: null,
              definition: { name: 'Serial Routine', prompt: 'Fixture', enabled: true, model: null, configuration: { agent: 'codex', skillIds: [], integrationIds: [] } }
            }
          })
          const first = yield* client['routines.createTask']({ vaultId: vault.id, input: { id: uuidv7(), routineId: routine.id, expectedRevision: 1 } })
          const second = yield* client['routines.createTask']({ vaultId: vault.id, input: { id: uuidv7(), routineId: routine.id, expectedRevision: 1 } })
          const firstSession = { vaultId: vault.id, taskId: first.task.id, sessionId: uuidv7(), agent: 'codex' as const }
          const secondSession = { vaultId: vault.id, taskId: second.task.id, sessionId: uuidv7(), agent: 'codex' as const }
          yield* client['tasks.openSession'](firstSession)
          yield* client['tasks.openSession'](secondSession)
          const firstRun = {
            vaultId: vault.id,
            taskId: first.task.id,
            sessionId: firstSession.sessionId,
            id: uuidv7(),
            prompt: 'running',
            purpose: 'execution' as const,
            resumesRunId: null
          }
          const nextRun = { ...firstRun, taskId: second.task.id, sessionId: secondSession.sessionId, id: uuidv7(), prompt: 'early-completion' }
          yield* client['tasks.startRun'](firstRun)
          expect(yield* client['tasks.startRun'](nextRun).pipe(Effect.flip)).toMatchObject({ reason: 'routine-busy' })
          expect((yield* client['tasks.get']({ vaultId: vault.id, id: second.task.id })).runs).toEqual([])
          yield* Effect.promise(async () => {
            await expect(access(join(second.task.worktree, 'turn-input.json'))).rejects.toMatchObject({ code: 'ENOENT' })
          })
          yield* client['tasks.cancelRun']({ vaultId: vault.id, taskId: first.task.id, runId: firstRun.id })
          expect((yield* client['tasks.startRun'](nextRun)).id).toBe(nextRun.id)
        }).pipe(Effect.scoped)
      )
    } finally {
      await app.dispose()
    }
  })

  it('retains claims before Task creation and refuses manual takeover of their reserved identities', async () => {
    await mkdir(join(root, 'wiki'))
    const app = runtime()
    try {
      await app.runPromise(
        Effect.gen(function* () {
          const vault = yield* (yield* VaultService).register(join(root, 'wiki'))
          const client = yield* RpcTest.makeClient(TaskRpcs)
          const definition = {
            name: 'Unavailable Integration',
            prompt: 'Use the missing Integration.',
            configuration: { agent: 'codex' as const, skillIds: [], integrationIds: ['missing'] },
            model: null,
            enabled: true
          }
          const id = uuidv7()
          yield* client['routines.save']({ vaultId: vault.id, input: { id, expectedRevision: null, definition } })
          const trigger = { id: uuidv7(), routineId: id, expectedRevision: 1 }
          expect(yield* client['routines.createTask']({ vaultId: vault.id, input: trigger }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
          expect(yield* client['tasks.list']({ vaultId: vault.id })).toEqual([])
          const [claim] = yield* client['routines.triggers']({ vaultId: vault.id, routineId: id })
          expect(claim).toBeDefined()
          expect(yield* client['tasks.create']({ vaultId: vault.id, id: claim!.taskId, goal: definition.prompt, agent: 'codex' }).pipe(Effect.flip)).toMatchObject({
            reason: 'invalid-state'
          })
          yield* client['routines.save']({
            vaultId: vault.id,
            input: { id, expectedRevision: 1, definition: { ...definition, configuration: { ...definition.configuration, integrationIds: [] } } }
          })
          expect(yield* client['routines.createTask']({ vaultId: vault.id, input: trigger }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
          const result = yield* client['routines.createTask']({ vaultId: vault.id, input: { ...trigger, id: uuidv7(), expectedRevision: 2 } })
          expect(result.task.id).not.toBe(claim!.taskId)
          expect(result.task.configuration.integrationIds).toEqual([])
          expect(yield* client['routines.triggers']({ vaultId: vault.id, routineId: id })).toHaveLength(2)
        }).pipe(Effect.scoped)
      )
    } finally {
      await app.dispose()
    }
  })

  it('materializes Routine snapshots through RPC without dispatch and retries failed worktree creation', async () => {
    await mkdir(join(root, 'wiki'))
    const app = runtime(Effect.fail(new AgentRuntimeError({ reason: 'unavailable', message: 'Execution must not start.' })))
    try {
      await app.runPromise(
        Effect.gen(function* () {
          const vault = yield* (yield* VaultService).register(join(root, 'wiki'))
          const client = yield* RpcTest.makeClient(TaskRpcs)
          const definition = {
            name: 'Notes',
            prompt: 'Summarize notes via skills.',
            configuration: { agent: 'codex' as const, skillIds: [], integrationIds: [] },
            model: null,
            enabled: true
          }
          const input = { id: uuidv7(), expectedRevision: null, definition }
          const saved = yield* client['routines.save']({ vaultId: vault.id, input })
          const trigger = { id: uuidv7(), routineId: saved.id, expectedRevision: saved.revision }
          // Force a filesystem failure after the durable claim and Task insert, before worktree creation.
          const parent = join(root, 'config/vaults', vault.id, 'worktrees')
          yield* Effect.promise(() => writeFile(parent, 'obstruction'))
          expect(yield* client['routines.createTask']({ vaultId: vault.id, input: trigger }).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
          const [accepted] = yield* client['routines.triggers']({ vaultId: vault.id, routineId: input.id })
          expect(accepted).toMatchObject({ ...trigger, snapshot: saved })
          const [pending] = yield* client['tasks.list']({ vaultId: vault.id })
          expect(pending).toMatchObject({ goal: definition.prompt, worktreeState: 'pending' })
          yield* client['routines.save']({ vaultId: vault.id, input: { ...input, expectedRevision: 1, definition: { ...definition, prompt: 'Changed prompt', enabled: false } } })
          yield* Effect.promise(() => rm(parent))
          const result = yield* client['routines.createTask']({ vaultId: vault.id, input: trigger })
          expect(result.task.id).toBe(pending!.id)
          expect(result.task.goal).toBe(definition.prompt)
          expect(result.task.worktreeState).toBe('ready')
          expect(result.trigger.snapshot).toEqual(saved)
          expect(yield* client['routines.createTask']({ vaultId: vault.id, input: trigger })).toEqual(result)
          const detail = yield* client['tasks.get']({ vaultId: vault.id, id: result.task.id })
          expect(detail).toMatchObject({ routine: result.trigger, sessions: [], runs: [] })
          expect(yield* client['routines.createTask']({ vaultId: vault.id, input: { ...trigger, id: uuidv7(), expectedRevision: 2 } }).pipe(Effect.flip)).toMatchObject({
            reason: 'invalid-state'
          })
          expect(yield* client['tasks.list']({ vaultId: vault.id })).toHaveLength(1)
          expect(yield* client['routines.list']({ vaultId: uuidv7() }).pipe(Effect.flip)).toMatchObject({ reason: 'not-found' })
        }).pipe(Effect.scoped)
      )
    } finally {
      await app.dispose()
    }
  })

  it.each((['pi', 'codex'] as const).filter((agent) => agent === 'pi' || process.platform !== 'win32'))(
    'persists Integration selection and mounts its snapshot for %s',
    async (agent) => {
      await mkdir(join(root, 'wiki'))
      if (agent === 'codex') {
        const fixture = await readFile(resolve('../../packages/agent/tests/fixtures/codex-app-server.mjs'), 'utf8')
        await writeFile(join(root, 'codex'), `#!/usr/bin/env node\n${fixture}`, { mode: 0o700 })
        vi.stubEnv('FOLIO_CODEX_EXECUTABLE', join(root, 'codex'))
      }
      const skill = join(root, 'config/integrations/notes/skills/notes/SKILL.md')
      const bin = join(root, 'config/integrations/notes/cli')
      let mountedAt: string | undefined
      const integration: Integration = {
        id: 'notes',
        name: 'Notes',
        description: 'Fixture',
        logo: '',
        homepage: 'https://example.test',
        states: { ready: { kind: 'ready', label: 'Ready' } },
        actions: [],
        install: () => Effect.void,
        check: () => Effect.void,
        inspect: () => Effect.succeed({ state: 'ready', actions: [] }),
        onActionCallback: () => Effect.void,
        resources: [
          {
            id: 'notes',
            name: 'Notes',
            onIngest: (context) =>
              Effect.sync(() => {
                mountedAt = context.workspaceDirectory
                context.skills.push(skill)
                context.executableDirectories.push(bin)
              })
          }
        ]
      }
      const app = runtime(undefined, [integration])
      try {
        await app.runPromise(
          Effect.gen(function* () {
            const vault = yield* (yield* VaultService).register(join(root, 'wiki'))
            const client = yield* RpcTest.makeClient(TaskRpcs)
            const input = { vaultId: vault.id, id: uuidv7(), goal: 'Use selected Integration', agent, integrationIds: ['notes'] }
            expect(yield* client['tasks.create'](input).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
            expect(yield* client['tasks.list']({ vaultId: vault.id })).toEqual([])
            const store = yield* IntegrationStore
            yield* store.create('notes')
            yield* store.register('notes', { id: 'notes', name: 'Notes' })
            yield* store.update('notes', 'ready', {}, [])
            const task = yield* client['tasks.create'](input)
            expect(task.configuration.integrationIds).toEqual(['notes'])
            expect(yield* client['tasks.create']({ ...input, integrationIds: [] }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
            const models = yield* ModelService
            const model = (yield* models.listCatalog).models.find((model) => model.providerId === 'anthropic' && model.source === 'builtin')!
            yield* models.setProviderCredential(model.providerId, Redacted.make('fixture-no-model-request'))
            const sessionInput = {
              vaultId: vault.id,
              taskId: task.id,
              sessionId: uuidv7(),
              agent,
              ...(agent === 'pi' ? { model: { providerId: model.providerId, modelId: model.modelId, thinkingLevel: 'off' as const } } : {})
            }
            expect(yield* client['tasks.openSession'](sessionInput).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
            yield* client['tasks.closeSession'](sessionInput)
            yield* Effect.promise(async () => {
              await mkdir(join(root, 'config/integrations/notes/skills/notes'), { recursive: true })
              await mkdir(bin)
              await writeFile(skill, '---\nname: notes\ndescription: Test Integration\n---\n')
            })
            const session = yield* client['tasks.openSession'](sessionInput)
            expect(session.nativeSessionId).toBeTruthy()
            expect(mountedAt).toBe(task.worktree)
            yield* client['tasks.closeSession'](sessionInput)
            const pinnedSkill = join(root, 'config/vaults', vault.id, 'resources', task.id, 'notes/skills/notes/SKILL.md')
            if (agent === 'codex')
              expect(JSON.parse(yield* Effect.promise(() => readFile(join(task.worktree, 'skill-roots.json'), 'utf8')))).toEqual([
                join(root, 'config/vaults', vault.id, 'resources', task.id, 'notes/skills/notes')
              ])
            expect(yield* Effect.promise(() => readFile(pinnedSkill, 'utf8'))).toContain('Test Integration')
            yield* Effect.promise(() => writeFile(skill, '---\nname: notes\ndescription: Updated Integration\n---\n'))
            expect((yield* client['tasks.openSession'](sessionInput)).nativeSessionId).toBe(session.nativeSessionId)
            expect(yield* Effect.promise(() => readFile(pinnedSkill, 'utf8'))).toContain('Test Integration')
            yield* client['tasks.closeSession'](sessionInput)
            yield* store.update('notes', 'unavailable', {}, [])
            // A retry of task creation uses its existing snapshot even if the installation later becomes unavailable.
            expect(yield* client['tasks.create'](input)).toEqual(task)
            expect(yield* client['tasks.openSession'](sessionInput).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
            const detail = yield* client['tasks.get']({ vaultId: vault.id, id: task.id })
            expect(detail.runs).toEqual([])
            expect(detail.sessions[0]?.nativeSessionId).toBe(session.nativeSessionId)
          }).pipe(Effect.scoped)
        )
      } finally {
        await app.dispose()
      }
    }
  )

  it('keeps Task browsing available when the runtime is missing and does not allocate a Session on that failure', async () => {
    await mkdir(join(root, 'wiki'))
    const app = runtime(Effect.fail(new AgentRuntimeError({ reason: 'unavailable', message: 'Missing runtime' })))
    try {
      await app.runPromise(
        Effect.gen(function* () {
          const vault = yield* (yield* VaultService).register(join(root, 'wiki'))
          const client = yield* RpcTest.makeClient(TaskRpcs)
          const id = uuidv7()
          yield* client['tasks.create']({ vaultId: vault.id, id, goal: 'Retain Task', agent: 'pi' })
          expect(yield* client['tasks.openSession']({ vaultId: vault.id, taskId: id, sessionId: uuidv7(), agent: 'pi' }).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
          expect(yield* client['tasks.list']({ vaultId: vault.id })).toHaveLength(1)
          expect((yield* client['tasks.get']({ vaultId: vault.id, id })).sessions).toEqual([])
        }).pipe(Effect.scoped)
      )
    } finally {
      await app.dispose()
    }
  })

  it('initializes Pi from Provider-only settings and restores the immutable model without a Prompt', async () => {
    await mkdir(join(root, 'wiki'))
    const app = runtime()
    try {
      await app.runPromise(
        Effect.gen(function* () {
          const models = yield* ModelService
          const entry = (yield* models.listCatalog).models.find((model) => model.providerId === 'anthropic' && model.source === 'builtin')!
          const selection = { providerId: entry.providerId, modelId: entry.modelId, thinkingLevel: 'off' as const }
          const vault = yield* (yield* VaultService).register(join(root, 'wiki'))
          const client = yield* RpcTest.makeClient(TaskRpcs)
          const taskId = uuidv7()
          yield* client['tasks.create']({ vaultId: vault.id, id: taskId, goal: 'Explicit Pi model', agent: 'pi' })
          const input = { vaultId: vault.id, taskId, sessionId: uuidv7(), agent: 'pi' as const, model: selection }
          expect(yield* client['tasks.openSession'](input).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
          expect((yield* client['tasks.get']({ vaultId: vault.id, id: taskId })).sessions).toEqual([])
          yield* models.setProviderCredential(entry.providerId, Redacted.make('fixture-key-no-network'))
          expect((yield* models.list).profiles).toEqual([])
          const saved = yield* client['tasks.openSession'](input)
          expect(saved.modelProfile).toMatchObject({ provider: { providerId: entry.providerId }, modelId: entry.modelId })
          expect(JSON.stringify(saved)).not.toContain('fixture-key-no-network')
          expect(yield* client['tasks.openSession']({ ...input, model: { ...selection, thinkingLevel: 'high' } }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
          yield* client['tasks.closeSession'](input)
          yield* (yield* ConfigService).setAgent({ enabled: false, modelProfiles: [] })
          const { model: _selection, ...restore } = input
          expect(yield* client['tasks.openSession'](restore)).toEqual(saved)
          const detail = yield* client['tasks.get']({ vaultId: vault.id, id: taskId })
          expect(detail.runs).toEqual([])
          const runtimeDirectory = join(root, 'config/vaults', vault.id, 'agent-history/runtime', input.sessionId)
          expect(yield* Effect.promise(() => readFile(join(runtimeDirectory, 'models.generated.json'), 'utf8'))).not.toContain('fixture-key-no-network')
          expect(yield* Effect.promise(() => readdir(runtimeDirectory))).not.toContain('auth.json')
        }).pipe(Effect.scoped)
      )
    } finally {
      await app.dispose()
    }
  }, 20000)

  it.skipIf(process.platform === 'win32')(
    'opens and restores a Vault-owned Session without a Prompt, keeping it alive between RPC clients',
    async () => {
      await mkdir(join(root, 'wiki'))
      const fixture = (await readFile(resolve('../../packages/agent/tests/fixtures/codex-app-server.mjs'), 'utf8')).replace(
        'if (method === "initialize") return send({ id, result: { userAgent: "fixture" } });',
        'if (method === "initialize") { writeFileSync("native-pid", String(process.pid)); return send({ id, result: { userAgent: "fixture" } }); }'
      )
      await writeFile(join(root, 'codex'), `#!/usr/bin/env node\n${fixture}`, { mode: 0o700 })
      vi.stubEnv('FOLIO_CODEX_EXECUTABLE', join(root, 'codex'))
      vi.stubEnv('FOLIO_AGENT_DIR', join(root, 'shared-agent'))
      const app = runtime()
      let nativePid = 0
      let vaultId = ''
      const taskId = uuidv7()
      const sessionId = uuidv7()
      try {
        await app.runPromise(
          Effect.gen(function* () {
            const vault = yield* (yield* VaultService).register(join(root, 'wiki'))
            vaultId = vault.id
            const client = yield* RpcTest.makeClient(TaskRpcs)
            const task = yield* client['tasks.create']({ vaultId, id: taskId, goal: 'Session lifecycle', agent: 'codex' })
            const input = { vaultId, taskId, sessionId, agent: 'codex' as const }
            const opened = yield* Effect.all([client['tasks.openSession'](input), client['tasks.openSession'](input)], { concurrency: 'unbounded' })
            expect(opened[0]).toEqual(opened[1])
            expect(opened[0]).toMatchObject({ id: sessionId, nativeSessionId: 'native-thread', adapterVersion: '0.1.0' })
            nativePid = Number(yield* Effect.promise(() => readFile(join(task.worktree, 'native-pid'), 'utf8')))
            const archivePath = join(root, 'config/vaults', vaultId, 'agent-history/acp-sessions', opened[0]!.acpSessionId!, 'header.json')
            expect(JSON.parse(yield* Effect.promise(() => readFile(archivePath, 'utf8')))).toMatchObject({ cwd: task.worktree })
            expect((yield* client['tasks.get']({ vaultId, id: taskId })).runs).toEqual([])
            expect(yield* client['tasks.openSession']({ ...input, agent: 'pi' }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
          }).pipe(Effect.scoped)
        )
        expect(() => process.kill(nativePid, 0)).not.toThrow()
        await app.runPromise(
          Effect.gen(function* () {
            const client = yield* RpcTest.makeClient(TaskRpcs)
            const before = (yield* client['tasks.get']({ vaultId, id: taskId })).sessions
            yield* client['tasks.closeSession']({ vaultId, taskId, sessionId })
            expect(() => process.kill(nativePid, 0)).toThrow()
            expect(yield* client['tasks.openSession']({ vaultId, taskId, sessionId, agent: 'codex' })).toEqual(before[0])
            const detail = yield* client['tasks.get']({ vaultId, id: taskId })
            nativePid = Number(yield* Effect.promise(() => readFile(join(detail.task.worktree, 'native-pid'), 'utf8')))
            expect(detail.runs).toEqual([])
          }).pipe(Effect.scoped)
        )
      } finally {
        await app.dispose()
      }
      expect(() => process.kill(nativePid, 0)).toThrow()
    },
    15000
  )

  it.skipIf(process.platform === 'win32')(
    'owns Runs across clients, coalesces retries, cancels and records Quit interruption without replay',
    async () => {
      await mkdir(join(root, 'wiki'))
      const fixture = (await readFile(resolve('../../packages/agent/tests/fixtures/codex-app-server.mjs'), 'utf8')).replace(
        'const mode = params.input[0].text;',
        'const mode = params.input[0].text; writeFileSync("dispatch-count", String(++globalThis.dispatchCount || (globalThis.dispatchCount = 1)));'
      ).replace(
        'if (method === "initialize") return send({ id, result: { userAgent: "fixture" } });',
        'if (method === "initialize") { writeFileSync("native-pid", String(process.pid)); return send({ id, result: { userAgent: "fixture" } }); }'
      )
      await writeFile(join(root, 'codex'), `#!/usr/bin/env node\n${fixture}`, { mode: 0o700 })
      vi.stubEnv('FOLIO_CODEX_EXECUTABLE', join(root, 'codex'))
      const app = runtime()
      let vaultId = ''
      let worktree = ''
      const taskId = uuidv7()
      const sessionId = uuidv7()
      const quitId = uuidv7()
      try {
        await app.runPromise(
          Effect.gen(function* () {
            const vault = yield* (yield* VaultService).register(join(root, 'wiki'))
            vaultId = vault.id
            const client = yield* RpcTest.makeClient(TaskRpcs)
            const task = yield* client['tasks.create']({ vaultId, id: taskId, goal: 'Runs', agent: 'codex' })
            worktree = task.worktree
            yield* client['tasks.openSession']({ vaultId, taskId, sessionId, agent: 'codex' })
            const input = { vaultId, id: uuidv7(), taskId, sessionId, prompt: 'early-completion', purpose: 'execution' as const, resumesRunId: null }
            const accepted = yield* Effect.all([client['tasks.startRun'](input), client['tasks.startRun'](input)], { concurrency: 'unbounded' })
            expect(accepted[0]!.id).toBe(input.id)
            expect(accepted[1]!.id).toBe(input.id)
            yield* Effect.promise(() =>
              vi.waitFor(async () => {
                const detail = await app.runPromise(Effect.flatMap(TaskService, (service) => service.get(vaultId, taskId)))
                expect(detail.runs).toMatchObject([{ id: input.id, state: 'succeeded', syncState: 'pending' }])
              })
            )
            const stoppedPid = Number(yield* Effect.promise(() => readFile(join(worktree, 'native-pid'), 'utf8')))
            expect(() => process.kill(stoppedPid, 0)).toThrow()
            expect(yield* client['tasks.startRun'](input)).toMatchObject({ id: input.id, state: 'succeeded' })
            expect(yield* client['tasks.startRun']({ ...input, prompt: 'Different intent' }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
            expect(yield* Effect.promise(() => readFile(join(worktree, 'dispatch-count'), 'utf8'))).toBe('1')
            yield* client['tasks.startRun']({ ...input, id: quitId, prompt: 'running' })
            expect(yield* client['tasks.complete']({ vaultId, taskId }).pipe(Effect.flip)).toMatchObject({ reason: 'task-busy' })
          }).pipe(Effect.scoped)
        )
        // The first requesting client's Scope is gone; the app-owned worker still accepts cancellation.
        await app.runPromise(
          Effect.gen(function* () {
            const client = yield* RpcTest.makeClient(TaskRpcs)
            const input = { vaultId, id: uuidv7(), taskId, sessionId, prompt: 'running', purpose: 'execution' as const, resumesRunId: null }
            expect(yield* client['tasks.startRun'](input).pipe(Effect.flip)).toMatchObject({ reason: 'task-busy' })
            expect(yield* client['tasks.cancelRun']({ vaultId, taskId, runId: quitId })).toMatchObject({ state: 'cancelled', syncState: 'pending' })
            expect(yield* client['tasks.cancelRun']({ vaultId, taskId, runId: quitId })).toMatchObject({ state: 'cancelled' })
            yield* client['tasks.startRun']({ ...input, purpose: 'recovery', resumesRunId: quitId })
            yield* Effect.promise(() =>
              vi.waitFor(async () => {
                const detail = await app.runPromise(Effect.flatMap(TaskService, (service) => service.get(vaultId, taskId)))
                expect(detail.runs.find((run) => run.id === input.id)?.state).toBe('running')
              })
            )
            yield* Effect.promise(() => writeFile(join(worktree, 'wiki/retained.md'), 'unfinished work'))
          }).pipe(Effect.scoped)
        )
      } finally {
        await app.dispose()
      }
      const count = await readFile(join(worktree, 'dispatch-count'), 'utf8')
      const restarted = runtime()
      try {
        await restarted.runPromise(
          Effect.gen(function* () {
            const client = yield* RpcTest.makeClient(TaskRpcs)
            const detail = yield* client['tasks.get']({ vaultId, id: taskId })
            expect(detail.runs.map((run) => run.state)).toEqual(['succeeded', 'cancelled', 'interrupted'])
            expect(detail.runs[2]).toMatchObject({ purpose: 'recovery', resumesRunId: quitId })
            expect(detail.task.state).toBe('active')
            expect(yield* Effect.promise(() => readFile(join(worktree, 'dispatch-count'), 'utf8'))).toBe(count)
            expect(yield* Effect.promise(() => readFile(join(worktree, 'wiki/retained.md'), 'utf8'))).toBe('unfinished work')
          }).pipe(Effect.scoped)
        )
      } finally {
        await restarted.dispose()
      }
    },
    20000
  )

  it.skipIf(process.platform === 'win32').each([
    ['failed', 'failed'],
    ['crash', 'interrupted'],
    ['unfinished-tool', 'interrupted'],
    ['projection-failure', 'interrupted']
  ])(
    'retains %s output and releases the Run only after terminal handling',
    async (mode, outcome) => {
      await mkdir(join(root, 'wiki'))
      const fixture = (await readFile(resolve('../../packages/agent/tests/fixtures/codex-app-server.mjs'), 'utf8')).replace(
        'notify("item/completed", { item: { ...command, status: "completed", aggregatedOutput: "one two" } });',
        'if (mode !== "unfinished-tool") notify("item/completed", { item: { ...command, status: "completed", aggregatedOutput: "one two" } });'
      )
      await writeFile(join(root, 'codex'), `#!/usr/bin/env node\n${fixture}`, { mode: 0o700 })
      vi.stubEnv('FOLIO_CODEX_EXECUTABLE', join(root, 'codex'))
      const app = runtime()
      try {
        await app.runPromise(
          Effect.gen(function* () {
            const vault = yield* (yield* VaultService).register(join(root, 'wiki'))
            const client = yield* RpcTest.makeClient(TaskRpcs)
            const taskId = uuidv7(),
              sessionId = uuidv7(),
              runId = uuidv7()
            yield* client['tasks.create']({ vaultId: vault.id, id: taskId, goal: 'Failure handling', agent: 'codex' })
            yield* client['tasks.openSession']({ vaultId: vault.id, taskId, sessionId, agent: 'codex' })
            if (mode === 'projection-failure') {
              const db = new DatabaseSync(join(root, 'config/vaults', vault.id, 'data.db'))
              try {
                db.exec("CREATE TRIGGER fail_messages BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'fixture'); END")
              } finally {
                db.close()
              }
            }
            const input = { vaultId: vault.id, taskId, sessionId, id: runId, prompt: mode!, purpose: 'execution' as const, resumesRunId: null }
            yield* client['tasks.startRun'](input)
            yield* Effect.promise(() =>
              vi.waitFor(async () => {
                const detail = await app.runPromise(Effect.flatMap(TaskService, (service) => service.get(vault.id, taskId)))
                expect(detail.runs).toMatchObject([{ state: outcome, syncState: 'pending' }])
              })
            )
            expect(yield* client['tasks.startRun'](input)).toMatchObject({ id: runId, state: outcome })
            const history = yield* client['tasks.sessionHistory']({ vaultId: vault.id, taskId, sessionId })
            expect(history.messages.some((message) => message.data.role === 'user')).toBe(mode !== 'projection-failure')
            if (mode === 'unfinished-tool') expect(history.messages.filter(message => message.kind === 'tool_call')).toMatchObject([{ data: { status: 'in_progress' } }])
            expect(yield* client['tasks.sessionHistory']({ vaultId: vault.id, taskId: uuidv7(), sessionId }).pipe(Effect.flip)).toMatchObject({ reason: 'not-found' })
          }).pipe(Effect.scoped)
        )
      } finally {
        await app.dispose()
      }
    },
    15000
  )

  it.skipIf(process.platform !== 'darwin')(
    'reconciles a killed ACP owner only after its orphan native worker exits, without replaying its Prompt',
    async () => {
      await mkdir(join(root, 'wiki'))
      const fixture = (await readFile(resolve('../../packages/agent/tests/fixtures/codex-app-server.mjs'), 'utf8'))
        .replace('let turnNumber = 0;', 'let turnNumber = 0; setInterval(() => {}, 1000); writeFileSync("native-pid", String(process.pid));')
        .replace(
          'const mode = params.input[0].text;',
          'const mode = params.input[0].text; let count = 0; try { count = Number(readFileSync("dispatch-count", "utf8")) } catch {} writeFileSync("dispatch-count", String(count + 1));'
        )
      const executable = join(root, 'codex')
      await writeFile(executable, `#!/usr/bin/env node\n${fixture}`, { mode: 0o700 })
      vi.stubEnv('FOLIO_CODEX_EXECUTABLE', executable)
      const app = runtime()
      const scope = await Effect.runPromise(Scope.make())
      let disposeRaw = async () => {}
      let nativePid = 0
      try {
        const vault = await app.runPromise(Effect.flatMap(VaultService, (service) => service.register(join(root, 'wiki'))))
        const service = await app.runPromise(TaskService)
        const taskId = uuidv7(),
          sessionId = uuidv7(),
          runId = uuidv7()
        const task = await app.runPromise(service.create({ vaultId: vault.id, id: taskId, goal: 'Crash recovery', agent: 'codex' }))
        const directory = join(root, 'config/vaults', vault.id)
        // This low-level owner has no Run coordinator. Killing its ACP process reproduces the
        // durable state left when the application cannot execute its normal finalizers.
        const raw = ManagedRuntime.make(
          Layer.merge(HarnessStore.layer, HarnessEventStore.layer).pipe(Layer.provide(vaultDatabaseLayer(directory)), Layer.provideMerge(NodeServices.layer))
        )
        disposeRaw = () => raw.dispose()
        const store = await raw.runPromise(HarnessStore)
        await raw.runPromise(store.createSession({ id: sessionId, taskId, agent: 'codex', adapterVersion: '0.1.0', purpose: 'task', syncOperationId: null }))
        const old = await raw.runPromise(
          openHarnessSession({
            taskId,
            sessionId,
            nodeExecutable: process.execPath,
            entrypoint: resolve('../../packages/agent/dist/cli.js'),
            configDirectory: join(root, 'config'),
            agentDirectory: join(root, 'config/agent'),
            sessionStorageDirectory: join(directory, 'agent-history'),
            codexExecutable: executable
          }).pipe(Effect.provideService(Scope.Scope, scope))
        )
        const pending = old.prompt({ id: runId, taskId, sessionId, prompt: 'running', purpose: 'execution', resumesRunId: null, baselineCommit: task.worktreeBase! }).then(
          (value) => ({ value }),
          (error) => ({ error })
        )
        await vi.waitFor(async () => expect(await raw.runPromise(store.runs(taskId))).toMatchObject([{ state: 'running' }]))
        nativePid = Number(await readFile(join(task.worktree, 'native-pid'), 'utf8'))
        await writeFile(join(task.worktree, 'wiki/draft.md'), 'retained across crash')
        await expect(app.runPromise(service.inspectRun(vault.id, taskId, runId))).rejects.toMatchObject({ reason: 'task-busy' })
        process.kill(old.pid, 'SIGKILL')
        await pending
        await vi.waitFor(() => expect(() => process.kill(old.pid, 0)).toThrow())
        expect(() => process.kill(nativePid, 0)).not.toThrow()
        await expect(app.runPromise(service.inspectRun(vault.id, taskId, runId))).rejects.toMatchObject({ reason: 'task-busy' })
        expect((await raw.runPromise(store.runs(taskId)))[0]!.state).toBe('running')
        process.kill(nativePid, 'SIGKILL')
        await vi.waitFor(() => expect(() => process.kill(nativePid, 0)).toThrow())
        nativePid = 0
        const owners = join(directory, 'agent-history/acp-sessions/execution-owners.db')
        await rename(owners, `${owners}.bak`)
        await expect(app.runPromise(service.inspectRun(vault.id, taskId, runId))).rejects.toMatchObject({ reason: 'storage' })
        await expect(access(owners)).rejects.toThrow()
        await rename(`${owners}.bak`, owners)
        const saved = (await raw.runPromise(store.sessions(taskId)))[0]!
        const log = join(directory, 'agent-history/acp-sessions', saved.acpSessionId!, 'updates.jsonl')
        const original = await readFile(log, 'utf8')
        await writeFile(log, `${original}{`)
        await expect(app.runPromise(service.inspectRun(vault.id, taskId, runId))).rejects.toMatchObject({ reason: 'storage' })
        expect((await raw.runPromise(store.runs(taskId)))[0]!.state).toBe('running')
        await writeFile(log, '')
        await expect(app.runPromise(service.inspectRun(vault.id, taskId, runId))).rejects.toMatchObject({ reason: 'invalid-state' })
        expect((await raw.runPromise(store.runs(taskId)))[0]!.state).toBe('running')
        await writeFile(log, original)
        // Reproduce a durable adapter update whose IPC delivery was lost at the crash boundary.
        await new SessionArchive(join(directory, 'agent-history/acp-sessions')).append(saved.acpSessionId!, {
          sessionUpdate: 'agent_message',
          messageId: 'late-durable-output',
          content: [{ type: 'text', text: 'saved before the disconnect' }]
        })
        expect((await app.runPromise(service.history(vault.id, taskId, sessionId))).messages.some((message) => message.id === 'late-durable-output')).toBe(false)
        const withoutRuntime = runtime(Effect.fail(new AgentRuntimeError({ reason: 'unavailable', message: 'Missing bundle' })))
        try {
          await withoutRuntime.runPromise(
            Effect.gen(function* () {
              const client = yield* RpcTest.makeClient(TaskRpcs)
              expect(yield* client['tasks.inspectRun']({ vaultId: vault.id, taskId, runId })).toMatchObject({ state: 'interrupted', syncState: 'pending' })
            }).pipe(Effect.scoped)
          )
        } finally {
          await withoutRuntime.dispose()
        }
        expect(await app.runPromise(service.inspectRun(vault.id, taskId, runId))).toMatchObject({ state: 'interrupted' })
        const recoveredHistory = await app.runPromise(service.history(vault.id, taskId, sessionId))
        expect(recoveredHistory.messages.find((message) => message.id === 'late-durable-output')).toMatchObject({
          runId: null,
          data: { content: [{ text: 'saved before the disconnect' }] }
        })
        expect(recoveredHistory.messages.find((message) => message.data.role === 'user')?.runId).toBe(runId)
        expect(await readFile(join(task.worktree, 'dispatch-count'), 'utf8')).toBe('1')
        expect(await readFile(join(task.worktree, 'wiki/draft.md'), 'utf8')).toBe('retained across crash')
        // Recovery is a new explicit instruction, in the original native Session.
        const nextId = uuidv7()
        await app.runPromise(service.startRun({ vaultId: vault.id, taskId, sessionId, id: nextId, prompt: 'cancel-start', purpose: 'recovery', resumesRunId: runId }))
        await vi.waitFor(async () => expect(await readFile(join(task.worktree, 'dispatch-count'), 'utf8')).toBe('2'))
        expect(await app.runPromise(service.cancelRun(vault.id, taskId, nextId))).toMatchObject({ state: 'cancelled', resumesRunId: runId })
        expect((await app.runPromise(service.get(vault.id, taskId))).sessions[0]!.nativeSessionId).toBe(saved.nativeSessionId)
        expect((await new SessionArchive(join(directory, 'agent-history/acp-sessions')).read(saved.acpSessionId!)).history.length).toBeGreaterThan(0)
      } finally {
        if (nativePid) {
          try {
            process.kill(nativePid, 'SIGKILL')
          } catch {
            // The fixture may already have exited after the cancellation assertion.
          }
        }
        await Effect.runPromise(Scope.close(scope, Exit.void))
        await disposeRaw()
        await app.dispose()
      }
    },
    30000
  )

  it('isolates Vault resources, coalesces creation retries and persists across clients and application restart', async () => {
    await mkdir(join(root, 'a'))
    await mkdir(join(root, 'b'))
    const first = runtime()
    let vaultId = ''
    const id = uuidv7()
    try {
      await first.runPromise(
        Effect.gen(function* () {
          const vaults = yield* VaultService
          const a = yield* vaults.register(join(root, 'a'))
          const b = yield* vaults.register(join(root, 'b'))
          vaultId = a.id
          const client = yield* RpcTest.makeClient(TaskRpcs)
          const input = { vaultId: a.id, id, goal: 'Prepare notes', agent: 'pi' as const }
          const created = yield* Effect.all([client['tasks.create'](input), client['tasks.create'](input)], { concurrency: 'unbounded' })
          expect(created[0]).toEqual(created[1])
          expect(created[0]).toMatchObject({ worktreeState: 'ready', configuration: { agent: 'pi', skillIds: [], integrationIds: [] } })
          expect(yield* client['tasks.list']({ vaultId: a.id })).toHaveLength(1)
          expect(yield* client['tasks.list']({ vaultId: b.id })).toEqual([])
          expect(yield* client['tasks.get']({ vaultId: b.id, id }).pipe(Effect.flip)).toMatchObject({ reason: 'not-found' })
          expect(yield* client['tasks.create']({ ...input, goal: 'Different intent' }).pipe(Effect.flip)).toMatchObject({ reason: 'invalid-state' })
          // Identical Task IDs in separate Vault databases are independent resources.
          const other = yield* client['tasks.create']({ ...input, vaultId: b.id, agent: 'codex' })
          expect(other.worktree).not.toBe(created[0]!.worktree)
          expect((yield* client['tasks.list']({ vaultId: a.id }))[0]!.configuration.agent).toBe('pi')
          yield* Effect.promise(() => writeFile(join(created[0]!.worktree, 'wiki/draft.md'), 'retained draft'))
        }).pipe(Effect.scoped)
      )
      // Releasing the requesting client does not release the application's cached Vault resources.
      await first.runPromise(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(TaskRpcs)
          expect((yield* client['tasks.get']({ vaultId, id })).sessions).toEqual([])
        }).pipe(Effect.scoped)
      )
    } finally {
      await first.dispose()
    }
    const second = runtime()
    try {
      await second.runPromise(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(TaskRpcs)
          const detail = yield* client['tasks.get']({ vaultId, id })
          expect(detail.runs).toEqual([])
          expect(yield* Effect.promise(() => readFile(join(detail.task.worktree, 'wiki/draft.md'), 'utf8'))).toBe('retained draft')
          expect(yield* client['tasks.create']({ vaultId, id, goal: detail.task.goal, agent: 'pi' })).toEqual(detail.task)
        }).pipe(Effect.scoped)
      )
    } finally {
      await second.dispose()
    }
  })

  it('retains failed creation for same-ID retry and never creates storage for unknown Vaults', async () => {
    await mkdir(join(root, 'wiki'))
    const app = runtime()
    try {
      await app.runPromise(
        Effect.gen(function* () {
          const vault = yield* (yield* VaultService).register(join(root, 'wiki'))
          const client = yield* RpcTest.makeClient(TaskRpcs)
          expect(yield* client['tasks.list']({ vaultId: uuidv7() }).pipe(Effect.flip)).toMatchObject({ reason: 'not-found' })
          expect(yield* Effect.promise(() => readdir(join(root, 'config/vaults')))).toEqual([vault.id])
          const db = new DatabaseSync(join(root, 'config/vaults', vault.id, 'data.db'))
          try {
            db.exec("CREATE TRIGGER fail_ready BEFORE UPDATE OF worktree_state ON tasks WHEN NEW.worktree_state='ready' BEGIN SELECT RAISE(ABORT, 'fixture'); END")
            const input = { vaultId: vault.id, id: uuidv7(), goal: 'Retry worktree', agent: 'pi' as const }
            expect(yield* client['tasks.create'](input).pipe(Effect.flip)).toMatchObject({ reason: 'storage' })
            expect((yield* client['tasks.list']({ vaultId: vault.id }))[0]).toMatchObject({ id: input.id, worktreeState: 'creating' })
            db.exec('DROP TRIGGER fail_ready')
            expect(yield* client['tasks.create'](input)).toMatchObject({ id: input.id, worktreeState: 'ready' })
            expect(yield* client['tasks.list']({ vaultId: vault.id })).toHaveLength(1)
          } finally {
            db.close()
          }
        }).pipe(Effect.scoped)
      )
    } finally {
      await app.dispose()
    }
  })
})
