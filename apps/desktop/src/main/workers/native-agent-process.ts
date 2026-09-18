import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import type { CodexProcessTransport } from '@folio/agent'

/** Main-thread ownership retains Node's reaper even if the SDK Worker terminates abruptly. */
export class NativeAgentProcess {
  readonly child: ChildProcessWithoutNullStreams
  readonly exited: Promise<void>
  readonly ready: Promise<void>
  private closing?: Promise<void>
  constructor(executable: string, cwd: string, environment?: NodeJS.ProcessEnv, args: readonly string[] = ['app-server', '--listen', 'stdio://', '--config', 'skills.include_instructions=false']) {
    this.child = spawn(executable, [...args], {
      cwd, env: environment, detached: process.platform !== 'win32', windowsHide: true, stdio: 'pipe'
    })
    this.exited = new Promise(resolve => this.child.once('close', () => resolve()))
    this.ready = new Promise((resolve, reject) => {
      this.child.once('spawn', resolve)
      this.child.once('error', reject)
    })
    // Writes can race a native exit; the Worker sees the corresponding stream/exit failure.
    this.child.stdin.on('error', () => {})
  }
  streams(): Pick<CodexProcessTransport, 'pid' | 'stdin' | 'stdout' | 'stderr'> {
    if (!this.child.pid) throw new Error('Native Agent process could not start.')
    return { pid: this.child.pid,
      stdin: Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>,
      stdout: Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(this.child.stderr) as ReadableStream<Uint8Array> }
  }
  private signal(signal: NodeJS.Signals): void {
    const pid = this.child.pid
    if (!pid) return
    try { process.kill(process.platform === 'win32' ? pid : -pid, signal) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
  /** Whole-group termination plus the retained child close event prove cleanup. */
  close(): Promise<void> {
    return this.closing ??= (async () => {
      await this.ready.catch(() => {})
      if (!this.child.pid) { await this.exited; return }
      if (process.platform === 'win32' && this.child.exitCode === null && this.child.signalCode === null) {
        await new Promise<void>((resolve, reject) => execFile('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], error => {
          if (error && this.child.exitCode === null && this.child.signalCode === null) reject(error)
          else resolve()
        }))
        await this.exited
        return
      }
      try { this.signal('SIGTERM') }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
        // Darwin reports EPERM for a group containing only an unreaped child.
        // The SDK may have killed it just before our group signal. Only continue
        // if Node actually observes close; real permission failures stay failures.
        let timeout: ReturnType<typeof setTimeout> | undefined
        try {
          const exited = await Promise.race([this.exited.then(() => true), new Promise<boolean>(resolve => {
            timeout = setTimeout(() => resolve(false), 2000)
          })])
          if (!exited) throw error
        } finally { clearTimeout(timeout) }
      }
      const timer = setTimeout(() => { try { this.signal('SIGKILL') } catch { /* Verified below. */ } }, 2000)
      try { await this.exited } finally { clearTimeout(timer) }
      // The group may outlive its leader, so clean remaining descendants too.
      this.signal('SIGKILL')
    })().catch(error => { this.closing = undefined; throw error })
  }
}
