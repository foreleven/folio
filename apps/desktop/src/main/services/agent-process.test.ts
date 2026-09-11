import { NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openAgentProcess, type AgentProcessOptions } from './agent-process'

let root: string
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'folio-agent-process-'))) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
/** Private fixture entrypoints use the production runtime verifier and process transport. */
function options(entrypoint: string): AgentProcessOptions {
  return { nodeExecutable: process.execPath, entrypoint, cwd: root, configDirectory: join(root, 'config'), agentDirectory: join(root, 'agent'), agent: 'codex' }
}

describe('standalone Agent process boundary', () => {
  it.each(['cooperative', 'ignores-sigterm'])('drains stderr and reaps a %s process when its Scope closes', async mode => {
    const entrypoint = join(root, 'agent.mjs')
    await writeFile(entrypoint, `
      ${mode === 'ignores-sigterm' ? "process.on('SIGTERM', () => {});" : ''}
      process.stderr.write('fixture private diagnostics'.repeat(20000));
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'ready',params:{cwd:process.cwd(),args:process.argv.slice(2),config:process.env.FOLIO_CONFIG_DIR,agent:process.env.FOLIO_AGENT_DIR,path:process.env.PATH}})+'\\n');
      setInterval(() => {}, 1000);
    `)
    const pid = await Effect.runPromise(Effect.gen(function*() {
      const process = yield* openAgentProcess(options(entrypoint))
      expect(process.nodeVersion).toMatch(/^\d+\./)
      const reader = process.stream.readable.getReader()
      try {
        const ready = yield* Effect.promise(() => reader.read())
        expect(ready.value).toMatchObject({ method: 'ready', params: {
          cwd: root, args: ['--agent', 'codex'], config: join(root, 'config'), agent: join(root, 'agent'),
          path: `${dirname(globalThis.process.execPath)}${delimiter}${globalThis.process.env.PATH ?? ''}`
        } })
      } finally { reader.releaseLock() }
      return process.pid
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
    expect(() => process.kill(pid, 0)).toThrow()
  }, 10000)

  it('rejects relative runtime paths and unavailable executables before opening the Agent', async () => {
    for (const [nodeExecutable, reason] of [['node', 'invalid-options'], [join(root, 'missing'), 'runtime-unavailable']]) {
      const result = await Effect.runPromise(openAgentProcess({ ...options(join(root, 'agent.mjs')), nodeExecutable: nodeExecutable! }).pipe(
        Effect.scoped, Effect.provide(NodeServices.layer), Effect.flip
      ))
      expect(result).toMatchObject({ reason })
    }
  })

  it('reports early CLI exit and closes stdout', async () => {
    const entrypoint = join(root, 'exit.mjs')
    await writeFile(entrypoint, 'process.exit(7)')
    await Effect.runPromise(Effect.gen(function*() {
      const process = yield* openAgentProcess(options(entrypoint))
      expect(yield* process.exited).toBe(7)
      const reader = process.stream.readable.getReader()
      expect(yield* Effect.promise(() => reader.read())).toMatchObject({ done: true })
      reader.releaseLock()
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
  })

  it('reports malformed NDJSON bytes without retaining their contents', async () => {
    const entrypoint = join(root, 'malformed.mjs')
    await writeFile(entrypoint, `process.stdout.write(Buffer.from([0xff,0xfe,0x0a]));process.stdout.write('{not-json}\\n');setInterval(()=>{},1000)`)
    const diagnostics: Array<{ reason: string; byteLength: number; sha256: string }> = []
    await Effect.runPromise(Effect.gen(function*() {
      const child = yield* openAgentProcess({ ...options(entrypoint), onMalformedInput: diagnostic => { diagnostics.push(diagnostic) } })
      const reader = child.stream.readable.getReader()
      try {
        yield* Effect.promise(() => vi.waitFor(() => expect(diagnostics).toHaveLength(2)))
      } finally { reader.releaseLock() }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
    expect(diagnostics.map(({ reason, byteLength }) => ({ reason, byteLength }))).toEqual([
      { reason: 'invalid-utf8', byteLength: 2 }, { reason: 'invalid-json', byteLength: 10 }
    ])
    expect(diagnostics.every(value => /^[0-9a-f]{64}$/.test(value.sha256))).toBe(true)
  })

  it('caps malformed-line sampling when one transport chunk is oversized', async () => {
    const entrypoint = join(root, 'oversized.mjs')
    await writeFile(entrypoint, `process.stdout.write(Buffer.alloc(1024 * 1024 + 4096, 0x78));process.stdout.write('\\n');setInterval(()=>{},1000)`)
    const diagnostics: Array<{ reason: string; byteLength: number; sha256: string }> = []
    await Effect.runPromise(Effect.gen(function*() {
      const child = yield* openAgentProcess({ ...options(entrypoint), onMalformedInput: diagnostic => { diagnostics.push(diagnostic) } })
      const reader = child.stream.readable.getReader()
      try {
        yield* Effect.promise(() => vi.waitFor(() => expect(diagnostics).toHaveLength(1)))
      } finally { reader.releaseLock() }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
    expect(diagnostics[0]).toMatchObject({ reason: 'line-too-large', byteLength: 1024 * 1024 + 1 })
    expect(diagnostics[0]?.sha256).toMatch(/^[0-9a-f]{64}$/)
  }, 10000)

  it('passes explicit Skill mounts and clears inherited mounts when none are selected', async () => {
    const entrypoint = join(root, 'mounts.mjs')
    await writeFile(entrypoint, "process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'mounts',params:{skills:JSON.parse(process.env.FOLIO_SESSION_SKILL_PATHS)}})+'\\n');setInterval(()=>{},1000)")
    const previous = process.env.FOLIO_SESSION_SKILL_PATHS
    try {
      process.env.FOLIO_SESSION_SKILL_PATHS = JSON.stringify([join(root, 'unselected')])
      for (const agent of ['pi', 'codex'] as const) for (const skillPaths of [undefined, [join(root, 'selected skill/SKILL.md')]]) {
        await Effect.runPromise(Effect.gen(function*() {
          const child = yield* openAgentProcess({ ...options(entrypoint), agent, skillPaths })
          const reader = child.stream.readable.getReader()
          try {
            expect((yield* Effect.promise(() => reader.read())).value).toMatchObject({ params: { skills: skillPaths ?? [] } })
          } finally { reader.releaseLock() }
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
      }
    } finally {
      if (previous === undefined) delete process.env.FOLIO_SESSION_SKILL_PATHS
      else process.env.FOLIO_SESSION_SKILL_PATHS = previous
    }
  })

  it.skipIf(process.platform === 'win32')('executes selected Integration tools by name while keeping bundled Node first', async () => {
    const bin = join(root, 'integration tools')
    await mkdir(bin)
    await writeFile(join(bin, 'folio-integration-fixture'), '#!/bin/sh\nprintf selected-tool', { mode: 0o700 })
    await writeFile(join(bin, 'node'), '#!/bin/sh\nprintf wrong-node', { mode: 0o700 })
    const entrypoint = join(root, 'tool-path.mjs')
    await writeFile(entrypoint, `import {execFileSync} from 'node:child_process';
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'tools',params:{
        output:execFileSync('folio-integration-fixture',[],{encoding:'utf8'}),
        node:execFileSync('node',['-p','process.execPath'],{encoding:'utf8'}).trim()
      }})+'\\n');setInterval(()=>{},1000)`)
    await Effect.runPromise(Effect.gen(function*() {
      const child = yield* openAgentProcess({ ...options(entrypoint), executableDirectories: [bin] })
      const reader = child.stream.readable.getReader()
      try {
        expect((yield* Effect.promise(() => reader.read())).value).toMatchObject({ params: {
          output: 'selected-tool', node: process.execPath
        } })
      } finally { reader.releaseLock() }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
    const invalid = await Effect.runPromise(openAgentProcess({ ...options(entrypoint), executableDirectories: [`${bin}${delimiter}/other`] }).pipe(
      Effect.scoped, Effect.provide(NodeServices.layer), Effect.flip))
    expect(invalid).toMatchObject({ reason: 'invalid-options' })
  })

  it('rejects a runtime probe that prints valid metadata but exits unsuccessfully', async () => {
    const preload = join(root, 'probe-exit.cjs')
    const launched = join(root, 'launched')
    const entrypoint = join(root, 'agent.mjs')
    // Exercise real Node stdout/exit ordering without replacing the process spawner or using a shell.
    await writeFile(preload, "if (process.argv.length === 1) process.on('exit', () => { process.exitCode = 7 })")
    await writeFile(entrypoint, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(launched)}, '')`)
    const previous = process.env.NODE_OPTIONS
    try {
      process.env.NODE_OPTIONS = `--require=${JSON.stringify(preload)}`
      const result = await Effect.runPromise(openAgentProcess(options(entrypoint)).pipe(
        Effect.scoped, Effect.provide(NodeServices.layer), Effect.flip
      ))
      expect(result).toMatchObject({ reason: 'runtime-unavailable' })
      await expect(access(launched)).rejects.toThrow()
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = previous
    }
  })
})
