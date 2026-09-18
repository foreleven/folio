import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

let root: string
let createHost: typeof import('./pi-tool-host')['createPiToolHost']

function deferred<A>() {
  let resolve!: (value: A) => void
  const promise = new Promise<A>(done => { resolve = done })
  return { promise, resolve }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'folio-tool-host-'))
  vi.stubEnv('PI_CODING_AGENT_DIR', root)
  vi.stubEnv('PI_OFFLINE', '1')
  await mkdir(join(root, 'bin'))
  await writeFile(join(root, 'example.txt'), 'search-result\n')
  for (const binary of ['fd', 'rg']) await writeFile(join(root, 'bin', binary), `#!/usr/bin/env node
const path = ${JSON.stringify(join(root, 'example.txt'))};
if (process.argv.includes('--version')) process.exit(0);
if (${JSON.stringify(binary)} === 'fd') console.log(path);
else console.log(JSON.stringify({type: 'match', data: {path: {text: path}, line_number: 1, lines: {text: 'search-result\\n'}}}));
if (process.env.FOLIO_SEARCH_MARKER) {
  require('node:fs').writeFileSync(process.env.FOLIO_SEARCH_MARKER, String(process.pid));
  setInterval(() => {}, 1000);
}
`, { mode: 0o700 })
  createHost = (await import('./pi-tool-host')).createPiToolHost
})
afterAll(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

describe.skipIf(process.platform === 'win32')('Pi native search tool ownership', () => {
  it.each(['find', 'grep'])('registers and joins the real %s process while preserving SDK output', async name => {
    const started: number[] = []
    const stopped: number[] = []
    const host = createHost(root, process.env, async pid => { started.push(pid) }, async pid => {
      expect(() => process.kill(pid, 0)).toThrow()
      stopped.push(pid)
    })
    try {
      const result = await host.run(name, 'call', { pattern: name === 'find' ? '*.txt' : 'search-result' })
      expect(result.content).toEqual([{ type: 'text', text: name === 'find' ? 'example.txt' : 'example.txt:1: search-result' }])
      expect(started).toHaveLength(1)
      expect(stopped).toEqual(started)
    } finally { await host.close() }
  })

  it.each(['find', 'grep', 'bash'])('joins %s registration and cleanup when cancelled during startup', async name => {
    const entered = deferred<number>()
    const registration = deferred<void>()
    const stopped: number[] = []
    const host = createHost(root, process.env, async pid => { entered.resolve(pid); await registration.promise },
      async pid => { expect(() => process.kill(pid, 0)).toThrow(); stopped.push(pid) })
    const controller = new AbortController()
    let completed = false
    let closed = false
    const result = host.run(name, 'cancel-start', name === 'bash' ? { command: 'printf should-not-run' } : { pattern: '*' }, controller.signal)
      .catch(error => error).finally(() => { completed = true })
    try {
      const pid = await entered.promise
      controller.abort()
      const closure = host.close().then(() => { closed = true })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(completed).toBe(false)
      expect(closed).toBe(false)
      registration.resolve()
      expect(await result).toBeInstanceOf(Error)
      await closure
      expect(stopped).toEqual([pid])
      await expect(host.run(name, 'later', { pattern: '*' })).rejects.toThrow('closed')
    } finally { registration.resolve(); await result; await host.close() }
  })

  it.each(['find', 'grep'])('fences %s startup when cancelled before asynchronous preparation returns', async name => {
    const started = vi.fn(async () => {})
    const host = createHost(root, process.env, started, async () => {})
    const execution = host.run(name, 'early-cancel', { pattern: '*' }).catch(error => error)
    host.cancel('early-cancel')
    expect(await execution).toBeInstanceOf(Error)
    await host.close()
    expect(started).not.toHaveBeenCalled()
  })

  it.each(['find', 'grep'])('waits for %s exit and its receipt after cancelling a running search', async name => {
    const receipt = deferred<void>()
    const exited = deferred<number>()
    const marker = join(root, `${name}-running`)
    const host = createHost(root, { ...process.env, FOLIO_SEARCH_MARKER: marker }, async () => {}, async pid => {
      expect(() => process.kill(pid, 0)).toThrow()
      exited.resolve(pid)
      await receipt.promise
    })
    let complete = false
    const execution = host.run(name, 'running', { pattern: '*' }).catch(error => error).finally(() => { complete = true })
    try {
      await vi.waitFor(() => access(marker), { timeout: 5000 })
      host.cancel('running')
      await Promise.race([exited.promise, execution.then(result => {
        throw new Error('Tool settled before its process exit receipt', { cause: result })
      })])
      expect(complete).toBe(false)
      await expect(host.run(name, 'running', { pattern: '*' })).rejects.toThrow('already active')
      receipt.resolve()
      expect(await execution).toBeInstanceOf(Error)
    } finally { receipt.resolve(); await host.close(); await execution }
  }, 15000)

  it('retains failed process cleanup receipts and retries them when closing', async () => {
    let allowReceipt = false
    const stopped = vi.fn(async (pid: number) => {
      expect(() => process.kill(pid, 0)).toThrow()
      if (!allowReceipt) throw new Error('receipt unavailable')
    })
    const host = createHost(root, process.env, async () => {}, stopped)
    try {
      await expect(host.run('find', 'receipt', { pattern: '*' })).rejects.toThrow('cleanup failed')
      await expect(host.close()).rejects.toThrow('cleanup failed')
      expect(stopped).toHaveBeenCalledTimes(2)
      allowReceipt = true
      await host.close()
      expect(stopped).toHaveBeenCalledTimes(3)
    } finally { allowReceipt = true; await host.close() }
  })

  it('does not execute a bash command when its process registration fails', async () => {
    const file = join(root, 'must-not-exist')
    const host = createHost(root, process.env, async () => { throw new Error('registration failed') }, async () => {})
    try {
      await expect(host.run('bash', 'failed-start', { command: `touch '${file}'` })).rejects.toThrow('registration failed')
      await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await host.close() }
  })
})
