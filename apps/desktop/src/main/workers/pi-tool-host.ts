import { makePiLocalToolExecutor, type PiToolExecutor } from '@folio/agent'
import { NativeAgentProcess } from './native-agent-process'

type OwnedProcess = {
  child: NativeAgentProcess
  registration: Promise<void>
  recorded: boolean
  stopping?: Promise<void>
}

/** Tool I/O stays in the host so a failed SDK thread cannot orphan native tool processes. */
export function createPiToolHost(cwd: string, environment: NodeJS.ProcessEnv | undefined,
  onStarted: (pid: number) => Promise<void>, onStopped: (pid: number) => Promise<void>) {
  const active = new Map<string, { controller: AbortController; completion: Promise<unknown> }>()
  const processes = new Set<OwnedProcess>()
  let closing = false
  let closure: Promise<void> | undefined

  /** Retain failed cleanup receipts so closing the host can retry without losing ownership. */
  const stop = (owned: OwnedProcess): Promise<void> => owned.stopping ??= (async () => {
    await owned.registration.catch(() => {})
    await owned.child.close()
    if (owned.recorded) await onStopped(owned.child.child.pid!)
    processes.delete(owned)
  })().catch(error => { owned.stopping = undefined; throw error })
  const stopAll = async (owned: Iterable<OwnedProcess>): Promise<void> => {
    const results = await Promise.allSettled([...owned].map(stop))
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (errors.length) throw new AggregateError(errors, 'Tool process cleanup failed.')
  }

  const run: PiToolExecutor = (name, id, params, signal, onUpdate) => {
    if (closing || active.has(id) || signal?.aborted) return Promise.reject(new Error('Tool execution is closed, cancelled or already active.'))
    const controller = new AbortController()
    const children = new Set<OwnedProcess>()
    let finished = false
    const abort = () => controller.abort()
    const abortChildren = () => {
      for (const owned of children) void owned.child.close().catch(() => {})
    }
    signal?.addEventListener('abort', abort, { once: true })
    controller.signal.addEventListener('abort', abortChildren)
    const checkActive = () => {
      if (finished || controller.signal.aborted || closing) throw new Error('Tool execution cancelled.')
    }
    const start = async (target: string, env: NodeJS.ProcessEnv | undefined, args: string[]): Promise<NativeAgentProcess> => {
      checkActive()
      const child = new NativeAgentProcess('bash', target, env, args)
      const owned: OwnedProcess = { child, recorded: false, registration: Promise.resolve() }
      children.add(owned)
      processes.add(owned)
      owned.registration = child.ready.then(async () => {
        await onStarted(child.child.pid!)
        owned.recorded = true
      })
      await owned.registration
      checkActive()
      return child
    }
    const execute = makePiLocalToolExecutor(cwd, { exec: async (command, target, options) => {
      const child = await start(target, { ...environment, ...options.env }, ['--noprofile', '--norc', '-s'])
      let timedOut = false
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        child.child.stdout.on('data', options.onData)
        child.child.stderr.on('data', options.onData)
        if (options.timeout !== undefined) timer = setTimeout(() => {
          timedOut = true
          void child.close().catch(() => {})
        }, options.timeout * 1000)
        // No user command reaches bash until its process identity is durably recorded.
        child.child.stdin.end(command + '\n')
        await child.exited
        if (timedOut) throw new Error('timeout:' + options.timeout)
        checkActive()
        return { exitCode: child.child.exitCode }
      } finally { clearTimeout(timer) }
    } }, async (executable, args) => {
      // exec preserves the registered PID/group. Waiting for stdin prevents search from
      // finishing before registration and before the SDK can attach its pipe listeners.
      const child = await start(cwd, environment, ['--noprofile', '--norc', '-c',
        'IFS= read -r _folio_start || exit; exec "$@"', 'folio-search', executable, ...args])
      child.child.stdin.end('\n')
      return child.child
    })
    const completion = execute(name, id, params, controller.signal, onUpdate).finally(async () => {
      // SDK cancellation can settle before asynchronous search preparation finishes.
      // Fence late spawn requests and join both registration and actual process exit.
      finished = true
      signal?.removeEventListener('abort', abort)
      controller.signal.removeEventListener('abort', abortChildren)
      try { await stopAll(children) } finally { active.delete(id) }
    })
    active.set(id, { controller, completion })
    return completion
  }
  return { run,
    cancel: (id: string): void => { active.get(id)?.controller.abort() },
    close: (): Promise<void> => closure ??= (async () => {
      closing = true
      for (const task of active.values()) task.controller.abort()
      await Promise.allSettled([...active.values()].map(task => task.completion))
      await stopAll(processes)
    })().catch(error => { closure = undefined; throw error })
  }
}
