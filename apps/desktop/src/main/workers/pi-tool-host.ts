import { makePiLocalToolExecutor, type PiToolExecutor } from '@folio/agent'
import { NativeAgentProcess } from './native-agent-process'

/** Tool I/O stays in the host so a failed SDK thread cannot orphan native tool processes. */
export function createPiToolHost(cwd: string, environment: NodeJS.ProcessEnv | undefined,
  onStarted: (pid: number) => Promise<void>, onStopped: (pid: number) => Promise<void>) {
  const active = new Map<string, { controller: AbortController; completion: Promise<unknown> }>()
  let closing = false
  const execute = makePiLocalToolExecutor(cwd, { exec: async (command, target, options) => {
    if (options.signal?.aborted || closing) throw new Error('Tool execution cancelled.')
    const child = new NativeAgentProcess('bash', target, { ...environment, ...options.env }, ['--noprofile', '--norc', '-s'])
    let recorded = false
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = () => { void child.close().catch(() => {}) }
    options.signal?.addEventListener('abort', abort, { once: true })
    try {
      await child.ready
      await onStarted(child.child.pid!)
      recorded = true
      if (options.signal?.aborted || closing) throw new Error('Tool execution cancelled.')
      child.child.stdout.on('data', options.onData)
      child.child.stderr.on('data', options.onData)
      if (options.timeout !== undefined) timer = setTimeout(() => { timedOut = true; abort() }, options.timeout * 1000)
      // No user command reaches bash until its process identity is durably recorded.
      child.child.stdin.end(command + '\n')
      await child.exited
      if (timedOut) throw new Error('timeout:' + options.timeout)
      if (options.signal?.aborted) throw new Error('aborted')
      return { exitCode: child.child.exitCode }
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      await child.close()
      if (recorded) await onStopped(child.child.pid!)
    }
  } })
  const run: PiToolExecutor = (name, id, params, _signal, onUpdate) => {
    if (closing || active.has(id)) return Promise.reject(new Error('Tool execution is closed or already active.'))
    const controller = new AbortController()
    const completion = execute(name, id, params, controller.signal, onUpdate).finally(() => active.delete(id))
    active.set(id, { controller, completion })
    return completion
  }
  return { run,
    cancel: (id: string): void => { active.get(id)?.controller.abort() },
    close: async (): Promise<void> => {
      closing = true
      for (const task of active.values()) task.controller.abort()
      await Promise.allSettled([...active.values()].map(task => task.completion))
    }
  }
}
