import { mkdir, mkdtemp, readFile, rm, writeFile, rename, open, symlink, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RunRecord } from '../../../shared/harness'
import { readRunLog, RunFileStore, RUN_LOG_LIMITS } from './run-files'

vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, rename: vi.fn(fs.rename), open: vi.fn(fs.open) }
})
let root: string
let files: RunFileStore
const run: RunRecord = { id: 'run', taskId: 'task', sessionId: 'session', sequence: 1, source: 'manual',
  owner: 'owner', prompt: 'private prompt', purpose: 'execution', resumesRunId: null, baselineCommit: null,
  state: 'preparing', syncState: 'not-required', cancelRequested: false, createdAt: 1, startedAt: 2, endedAt: null, error: null }
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'folio-run-files-')); files = new RunFileStore(root, 'vault') })
afterEach(async () => { vi.clearAllMocks(); await rm(root, { recursive: true, force: true }) })

it('persists bounded recovery information atomically and serializes concurrent updates', async () => {
  await files.begin(run)
  await Promise.all(Array.from({ length: 12 }, (_, index) => files.update(run.id, run.owner!, state => ({ ...state,
    processes: [...state.processes, { pid: index + 100, stopped: true }] }))))
  const reopened = new RunFileStore(root, 'vault')
  expect((await reopened.read('run', 'owner'))?.processes).toHaveLength(12)
  const raw = await readFile(join(root, 'runtime/runs/run/owner/state.json'), 'utf8')
  expect(raw).not.toContain('private prompt')
  await expect(files.update('run', 'owner', state => ({ ...state, owner: 'different' }))).rejects.toThrow('immutable')
  await expect(files.update('run', 'stale-owner', state => state)).rejects.toThrow('missing')
  await expect(files.read('../escape', 'owner')).rejects.toThrow('path identity')
})

it.each(['rename', 'disk-full'])('retains the previous valid snapshot when %s fails', async fault => {
  const original = await files.begin(run)
  if (fault === 'rename') vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('injected rename failure'), { code: 'EIO' }))
  else vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error('injected disk full'), { code: 'ENOSPC' }))
  await expect(files.update('run', 'owner', state => ({ ...state, result: { outcome: 'succeeded', error: null } }))).rejects.toThrow('injected')
  expect(await files.read('run', 'owner')).toEqual(original)
})

it('rejects damaged or foreign recovery files and will not delete owned resources', async () => {
  await files.begin(run)
  await files.update('run', 'owner', state => ({ ...state, processes: [{ pid: 101, stopped: false }] }))
  await expect(files.remove('run', 'owner')).rejects.toThrow('still owned')
  const path = join(root, 'runtime/runs/run/owner/state.json')
  const invalidPid = { ...(await files.read('run', 'owner')), ownerPid: -1 }
  await writeFile(path, JSON.stringify(invalidPid))
  await expect(files.list()).rejects.toThrow()
  await writeFile(path, '{broken')
  await expect(files.list()).rejects.toThrow()
})

it('buffers diagnostic lines, tolerates only a truncated tail, and retains active recovery state during pruning', async () => {
  const state = await files.begin(run)
  await files.log(state, 'claimed')
  const path = join(root, 'logs/runs/run/owner.jsonl')
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  await files.log(state, 'committed')
  const log = await readFile(path, 'utf8')
  expect(readRunLog(log)).toHaveLength(2)
  expect(readRunLog(log + '{unfinished')).toHaveLength(2)
  expect(() => readRunLog('{broken}\n' + log)).toThrow()
  const old = new Date(Date.now() - RUN_LOG_LIMITS.retentionMs - 1000)
  await utimes(path, old, old)
  await files.prune(new Set())
  expect(await readFile(path, 'utf8')).toBe(log)
  await files.prune(new Set(['run']))
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await files.read('run', 'owner')).not.toBeNull()
})

it('rotates diagnostic files and enforces the per-Vault byte budget without deleting active state', async () => {
  const previous = { ...RUN_LOG_LIMITS }
  try {
    RUN_LOG_LIMITS.fileBytes = 600
    RUN_LOG_LIMITS.vaultBytes = 900
    const state = await files.begin(run)
    for (let index = 0; index < 20; index++) await files.log(state, 'committed', { index })
    const { readdir, stat } = await import('node:fs/promises')
    const logRoot = join(root, 'logs/runs/run')
    const names = await readdir(logRoot)
    expect(names).toContain('owner.previous.jsonl')
    const sizes = await Promise.all(names.map(async name => (await stat(join(logRoot, name))).size))
    expect(sizes.every(size => size <= RUN_LOG_LIMITS.fileBytes)).toBe(true)
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(RUN_LOG_LIMITS.vaultBytes)
    expect(await files.read('run', 'owner')).not.toBeNull()
  } finally { Object.assign(RUN_LOG_LIMITS, previous) }
})

it('ignores Finder metadata and unrelated entries while writing and pruning owned logs', async () => {
  const logRoot = join(root, 'logs/runs')
  await mkdir(logRoot, { recursive: true })
  await writeFile(join(logRoot, '.DS_Store'), 'Finder metadata')
  await writeFile(join(logRoot, 'ordinary-file'), 'not a run directory')
  await mkdir(join(logRoot, 'unrelated.folder'))
  const state = await files.begin(run)
  await files.log(state, 'committed')
  const path = join(logRoot, 'run/owner.jsonl')
  expect(readRunLog(await readFile(path, 'utf8'))).toHaveLength(1)
  const old = new Date(Date.now() - RUN_LOG_LIMITS.retentionMs - 1000)
  await utimes(path, old, old)
  await files.prune(new Set(['run']))
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(logRoot, '.DS_Store'), 'utf8')).toBe('Finder metadata')
  expect(await files.read('run', 'owner')).not.toBeNull()
})

it.skipIf(process.platform === 'win32')('does not follow symlinked log directories or log files during retention', async () => {
  const outside = join(root, 'unrelated')
  const logs = join(root, 'logs/runs')
  await mkdir(outside)
  await mkdir(join(logs, 'run'), { recursive: true })
  const target = join(outside, 'owner.jsonl')
  await writeFile(target, 'unrelated data')
  const old = new Date(Date.now() - RUN_LOG_LIMITS.retentionMs - 1000)
  await utimes(target, old, old)
  await symlink(outside, join(logs, 'linked-run'))
  await symlink(target, join(logs, 'run/owner.jsonl'))
  await files.prune(new Set(['linked-run', 'run']))
  expect(await readFile(target, 'utf8')).toBe('unrelated data')
  expect(await readFile(join(logs, 'run/owner.jsonl'), 'utf8')).toBe('unrelated data')
})
