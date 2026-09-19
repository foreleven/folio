import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { UpdateSessionNotification } from '@agentclientprotocol/sdk/experimental/v2'
import { AgentWorkerClient } from './agent-worker-client'

/** Exercises the actual desktop build and native protocol fixture; never calls a provider. */
it.skipIf(process.platform === 'win32')('executes inside the built Worker, acknowledges messages and joins thread exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'folio-worker-'))
  const fixture = await readFile(resolve('../../packages/agent/tests/fixtures/codex-app-server.mjs'), 'utf8')
  const executable = join(root, 'codex.mjs')
  await writeFile(executable, '#!/usr/bin/env node\n' + fixture, { mode: 0o700 })
  const events: UpdateSessionNotification[] = []
  const processes: number[] = []
  let onRunning: (() => void) | undefined
  const worker = new AgentWorkerClient(resolve('out/main/agent-worker.js'), async event => {
    events.push(event)
    if ('state' in event.update && event.update.state === 'running') onRunning?.()
  }, undefined, async pid => { processes.push(pid) })
  try {
    const opened = await worker.open({ agent: 'codex', sessionId: 'test', cwd: root, configDirectory: root,
      agentDirectory: root, storageDirectory: root, runtimeDirectory: join(root, 'runtime'), codexExecutable: executable })
    expect(processes).toEqual([opened.processId])
    expect(opened.processId).not.toBe(process.pid)
    expect(worker.worker.threadId).toBeGreaterThan(0)
    expect((await worker.execute('early-completion')).update).toMatchObject({ state: 'idle', stopReason: 'end_turn' })
    expect(events.length).toBeGreaterThan(1)
    expect(events.map(event => event._meta?.['folio/eventSequence'])).toEqual(events.map((_, index) => index + 1))
    const started = new Promise<void>(resolve => { onRunning = resolve })
    const running = worker.execute('running')
    await started
    await worker.cancel()
    expect((await running).update).toMatchObject({ state: 'idle', stopReason: 'cancelled' })
    await worker.dispose()
    expect(await worker.exited).toBe(0)
  } finally {
    await worker.dispose().catch(() => worker.worker.terminate())
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

it.skipIf(process.platform === 'win32')('pool reaps a native process and releases Session ownership after its thread crashes', async () => {
  const { ManagedRuntime } = await import('effect')
  const { AgentWorkerPool } = await import('../services/agent/agent-worker-pool')
  const { hasExecutionProcess } = await import('../services/execution/execution-recovery')
  const runtime = ManagedRuntime.make(AgentWorkerPool.layer)
  const root = await mkdtemp(join(tmpdir(), 'folio-worker-crash-'))
  const executable = join(root, 'codex.mjs')
  await writeFile(executable, '#!/usr/bin/env node\n' + await readFile(resolve('../../packages/agent/tests/fixtures/codex-app-server.mjs'), 'utf8'), { mode: 0o700 })
  let nativePid = 0
  const receipts: string[] = []
  let running!: () => void
  const started = new Promise<void>(resolve => { running = resolve })
  try {
    const pool = await runtime.runPromise(AgentWorkerPool)
    const options = { agent: 'codex' as const, sessionId: 'crash-test', cwd: root, configDirectory: root,
      agentDirectory: root, storageDirectory: root, runtimeDirectory: join(root, 'runtime'), codexExecutable: executable }
    const lease = await pool.acquire({ entrypoint: resolve('out/main/agent-worker.js'), options,
      onStarted: async () => { receipts.push('worker-started') }, onStopped: async () => { receipts.push('worker-stopped') },
      onSessionBound: async () => {}, onProcessStarted: async pid => { nativePid = pid; receipts.push('process-started') },
      onProcessStopped: async () => { receipts.push('process-stopped') },
      onUpdate: async event => { if ('state' in event.update && event.update.state === 'running') running() }
    })
    await lease.client.open(options)
    const execution = lease.client.execute('running').catch(error => error)
    await started
    await lease.client.worker.terminate()
    expect(await execution).toBeInstanceOf(Error)
    await lease.close()
    expect(pool.hasThread(lease.threadId)).toBe(false)
    expect(hasExecutionProcess(nativePid)).toBe(false)
    expect(receipts).toEqual(['worker-started', 'process-started', 'process-stopped', 'worker-stopped'])
    // A fresh thread can now resume the same archive; no stale owner PID blocks it.
    const resumed = new AgentWorkerClient(resolve('out/main/agent-worker.js'), async () => {})
    try { await resumed.open({ ...options, resume: true }) } finally { await resumed.dispose() }
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
}, 30000)

it.skipIf(process.platform === 'win32')('runs Pi SDK in a Worker and delegates bash to the host with process receipts', async () => {
  const { createServer } = await import('node:http')
  const root = await mkdtemp(join(tmpdir(), 'folio-pi-worker-'))
  let requests = 0
  let bashCommand = 'printf worker-tool-ok'
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* Drain the local fixture request. */ }
    const first = requests++ % 2 === 0
    const deltas = first ? [
      { delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'bash-call', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: bashCommand }) } }] }, finish_reason: null },
      { delta: {}, finish_reason: 'tool_calls' }
    ] : [ { delta: { role: 'assistant', content: 'Done' }, finish_reason: null }, { delta: {}, finish_reason: 'stop' } ]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const choice of deltas) res.write('data: ' + JSON.stringify({ id: 'completion', object: 'chat.completion.chunk', created: 0,
      model: 'fixture', choices: [{ index: 0, ...choice }] }) + '\n\n')
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const receipts: string[] = []
  const events: UpdateSessionNotification[] = []
  const worker = new AgentWorkerClient(resolve('out/main/agent-worker.js'), async event => { events.push(event) },
    { ...process.env, FOLIO_TEST_API_KEY: 'local-fixture' },
    async pid => { receipts.push('start:' + pid) }, async () => {}, async pid => { receipts.push('stop:' + pid) })
  try {
    await worker.open({ agent: 'pi', sessionId: 'pi-worker', cwd: root, configDirectory: root,
      agentDirectory: join(root, 'agent'), storageDirectory: join(root, 'history'), runtimeDirectory: join(root, 'runtime'),
      modelProfile: { id: 'test', name: 'Test', provider: { type: 'custom', providerId: 'fixture',
        baseUrl: 'http://127.0.0.1:' + address.port + '/v1', api: 'openai-completions' }, modelId: 'fixture', thinkingLevel: 'off',
        credentialSource: 'environment', environmentVariable: 'FOLIO_TEST_API_KEY',
        customModel: { displayName: 'Fixture', reasoning: false, contextWindow: 16000, maxTokens: 4000 } } })
    expect((await worker.execute('Run the tool')).update).toMatchObject({ state: 'idle', stopReason: 'end_turn' })
    expect(requests).toBe(2)
    expect(receipts).toHaveLength(2)
    expect(receipts[1]).toBe(receipts[0]!.replace('start:', 'stop:'))
    expect(JSON.stringify(events)).toContain('worker-tool-ok')
    bashCommand = 'printf started > tool-started; exec sleep 30'
    const interrupted = worker.execute('Run delayed tool').catch(error => error)
    await vi.waitFor(async () => expect(await readFile(join(root, 'tool-started'), 'utf8')).toBe('started'), { timeout: 5000 })
    const toolPid = Number(receipts[2]!.split(':')[1])
    await worker.worker.terminate()
    expect(await interrupted).toBeInstanceOf(Error)
    await worker.closeNative()
    expect(receipts[3]).toBe('stop:' + toolPid)
    expect(() => process.kill(toolPid, 0)).toThrow()
  } finally {
    await worker.dispose().catch(async () => { await worker.worker.terminate(); await worker.closeNative() })
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
