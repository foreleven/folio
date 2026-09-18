import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { expect, it, vi } from 'vitest'
import { NativeAgentProcess } from './native-agent-process'

/** Darwin returns EPERM for a process group whose only member is a zombie. */
it.skipIf(process.platform !== 'darwin')('joins a child already killed by its SDK before verifying its process group', async () => {
  const native = new NativeAgentProcess(process.execPath, process.cwd(), process.env,
    ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'])
  try {
    await native.ready
    await once(native.child.stdout, 'data')
    native.child.kill('SIGTERM')
    // Stay synchronous while the child exits: libuv must not reap it before close().
    let state = ''
    for (let attempt = 0; attempt < 10 && !state.includes('Z'); attempt++) {
      state = execFileSync('ps', ['-p', String(native.child.pid), '-o', 'stat='], { encoding: 'utf8' })
    }
    expect(state).toContain('Z')
    await native.close()
    expect(() => process.kill(-native.child.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  } finally {
    // The child has already received SIGTERM even when the regression fails.
    await native.exited
    await native.close()
  }
})

it.skipIf(process.platform === 'win32')('retains a real group permission failure while its child is still alive', async () => {
  const native = new NativeAgentProcess(process.execPath, process.cwd(), process.env,
    ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'])
  await native.ready
  await once(native.child.stdout, 'data')
  const original = process.kill.bind(process)
  const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === -native.child.pid!) throw Object.assign(new Error('denied'), { code: 'EPERM' })
    return original(pid, signal)
  })
  try {
    await expect(native.close()).rejects.toMatchObject({ code: 'EPERM' })
    expect(process.kill(native.child.pid!, 0)).toBe(true)
  } finally { kill.mockRestore(); await native.close() }
})
