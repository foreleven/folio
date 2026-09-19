import { NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentRuntime } from './agent-runtime'

let root: string
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'folio-runtime-paths-'))) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
/** Resolver fixtures intentionally contain inert files; actual executability is checked by process/packaging tests. */
async function fixture() {
  await mkdir(join(root, 'bundle'), { recursive: true })
  await writeFile(join(root, 'bundle/agent-worker.js'), '')
}
/** Acquires only the application filesystem layer; runtime lookup never starts a process. */
function read(directory = join(root, 'bundle')) {
  return Effect.flatMap(AgentRuntime, runtime => runtime.get).pipe(
    Effect.provide(AgentRuntime.layer(directory)), Effect.provide(NodeServices.layer)
  )
}

describe('bundled Agent runtime paths', () => {
  it('resolves the unpacked Worker beside the packaged archive', async () => {
    const directory = join(root, 'app.asar.unpacked', 'out', 'main')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'agent-worker.js'), '')
    expect(await Effect.runPromise(read(join(root, 'app.asar', 'out', 'main')))).toMatchObject({
      entrypoint: join(directory, 'agent-worker.js')
    })
  })
  it('resolves the built application Worker entry', async () => {
    await fixture()
    expect(await Effect.runPromise(read())).toEqual({ entrypoint: join(root, 'bundle/agent-worker.js'), agentVersion: '0.1.0' })
  })
  it('keeps layer acquisition lazy and fails missing artifacts without falling back', async () => {
    await Effect.runPromise(Effect.asVoid(AgentRuntime).pipe(Effect.provide(AgentRuntime.layer(join(root, 'missing'))), Effect.provide(NodeServices.layer)))
    expect(await Effect.runPromise(read().pipe(Effect.flip))).toMatchObject({ reason: 'unavailable' })
    await fixture()
    await rm(join(root, 'bundle/agent-worker.js'))
    expect(await Effect.runPromise(read().pipe(Effect.flip))).toMatchObject({ reason: 'unavailable' })
    expect(await Effect.runPromise(read('relative').pipe(Effect.flip))).toMatchObject({ reason: 'unavailable' })
  })
  it.skipIf(process.platform === 'win32')('rejects an entrypoint redirected outside its build directory', async () => {
    await fixture()
    await rm(join(root, 'bundle/agent-worker.js'))
    await writeFile(join(root, 'outside-node'), '')
    await symlink(join(root, 'outside-node'), join(root, 'bundle/agent-worker.js'))
    expect(await Effect.runPromise(read().pipe(Effect.flip))).toMatchObject({ reason: 'unavailable' })
  })
})
