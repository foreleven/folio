import { createPiToolHost } from './pi-tool-host'
import { NativeAgentProcess } from './native-agent-process'
import { Worker, type Transferable } from 'node:worker_threads'
import type { UpdateSessionNotification } from '@agentclientprotocol/sdk/experimental/v2'
import type { AgentWorkerCommand, AgentWorkerEvent, AgentWorkerOptions } from './agent-worker-protocol'

/** One thread owns one Session; the application pool owns this client until exit. */
export class AgentWorkerClient {
  readonly worker: Worker
  readonly exited: Promise<number>
  private nextId = 0
  private readonly deliveries = new Set<Promise<void>>()
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }>()
  private toolHost?: ReturnType<typeof createPiToolHost>
  private native?: NativeAgentProcess
  private opening = false
  private terminal?: Error
  private disposal?: Promise<void>
  constructor(entrypoint: string | URL, readonly onUpdate: (notification: UpdateSessionNotification) => Promise<void>, readonly environment?: NodeJS.ProcessEnv, readonly onProcessStarted: (pid: number) => Promise<void> = async () => {}, readonly onSessionBound: (nativeSessionId: string) => Promise<void> = async () => {}, readonly onProcessStopped: (pid: number) => Promise<void> = async () => {}) {
    this.worker = new Worker(entrypoint, { env: environment, execArgv: [] })
    this.exited = new Promise(resolve => this.worker.once('exit', code => {
      this.fail(new Error('Agent Worker exited with code ' + code))
      resolve(code)
    }))
    this.worker.on('error', error => this.fail(error))
    this.worker.on('message', (event: AgentWorkerEvent) => {
      if (event.type === 'tool-cancel') { this.toolHost?.cancel(event.callId); return }
      if (event.type === 'tool') {
        const work = this.toolHost?.run(event.name, event.callId, event.params, undefined, value => {
          this.worker.postMessage({ type: 'tool-update', sequence: event.sequence, value } satisfies AgentWorkerCommand)
        }) ?? Promise.reject(new Error('Worker has no host tools.'))
        void work.then(value => this.worker.postMessage({ type: 'tool-result', sequence: event.sequence, value } satisfies AgentWorkerCommand),
          error => this.worker.postMessage({ type: 'tool-result', sequence: event.sequence,
            error: error instanceof Error ? error.message : 'Host tool execution failed.' } satisfies AgentWorkerCommand))
          .catch(error => this.fail(error instanceof Error ? error : new Error('Worker tool response failed.')))
        return
      }
      if (event.type === 'update'  || event.type === 'process-started' || event.type === 'session-bound' || event.type === 'native-close') {
        const delivery = Promise.resolve().then(() => event.type === 'update' ? this.onUpdate(event.notification) : event.type === 'process-started' ? this.onProcessStarted(event.pid) : event.type === 'session-bound' ? this.onSessionBound(event.nativeSessionId) : this.closeNative())
        this.deliveries.add(delivery)
        void delivery.then(
          () => this.worker.postMessage({ type: 'ack', sequence: event.sequence } satisfies AgentWorkerCommand),
          error => this.worker.postMessage({ type: 'ack', sequence: event.sequence,
            error: error instanceof Error ? error.message : 'Host event persistence failed.' } satisfies AgentWorkerCommand)
        ).catch(error => this.fail(error instanceof Error ? error : new Error('Worker event acknowledgement failed.')))
          .finally(() => this.deliveries.delete(delivery))
      } else {
        const pending = this.pending.get(event.id)
        this.pending.delete(event.id)
        clearTimeout(pending?.timer)
        if (event.type === 'result') pending?.resolve(event.value)
        else {
          const error = new Error(event.error.message)
          error.name = event.error.name
          error.stack = event.error.stack
          pending?.reject(error)
        }
      }
    })
  }
  private fail(error: Error): void {
    this.terminal ??= error
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(this.terminal) }
    this.pending.clear()
  }
  private request(command: { type: 'open'; options: AgentWorkerOptions; native?: ReturnType<NativeAgentProcess['streams']> } | { type: 'execute'; prompt: string } | { type: 'cancel' | 'dispose' }): Promise<unknown> {
    if (this.terminal) return Promise.reject(this.terminal)
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = command.type === 'execute' ? undefined : setTimeout(() => this.fail(new Error('Agent Worker ' + command.type + ' acknowledgement timed out.')), command.type === 'open' ? 30000 : 10000)
      this.pending.set(id, { resolve, reject, timer })
      try { this.worker.postMessage({ ...command, id }, command.type === 'open' && command.native ? [command.native.stdin, command.native.stdout, command.native.stderr] as unknown as Transferable[] : []) }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }
  async open(options: AgentWorkerOptions): Promise<{ nativeSessionId: string; processId: number }> {
    if (this.opening || this.terminal) throw this.terminal ?? new Error('Worker already owns a Session.')
    this.opening = true
    if (options.agent === 'pi') this.toolHost = createPiToolHost(options.cwd, this.environment ?? process.env, this.onProcessStarted, this.onProcessStopped)
    if (options.agent === 'codex') {
      this.native = new NativeAgentProcess(options.codexExecutable ?? 'codex', options.cwd, this.environment)
      await this.native.ready
      await this.onProcessStarted(this.native.child.pid!)
    }
    const result = this.request({ type: 'open', options, native: this.native?.streams() })
    // Post after open so the Worker sees even an already-completed native process.
    if (this.native) void this.native.exited.then(() => this.worker.postMessage({ type: 'native-exited' } satisfies AgentWorkerCommand))
      .catch(error => this.fail(error instanceof Error ? error : new Error('Worker native exit notification failed.')))
    return result as Promise<{ nativeSessionId: string; processId: number }>
  }
  async drainEvents(): Promise<void> { await Promise.allSettled([...this.deliveries]) }
  async closeNative(): Promise<void> { await this.toolHost?.close(); await this.native?.close() }
  execute(prompt: string): Promise<UpdateSessionNotification> {
    return this.request({ type: 'execute', prompt }) as Promise<UpdateSessionNotification>
  }
  async cancel(): Promise<void> { await this.request({ type: 'cancel' }) }
  /** Never considers an acknowledgement alone proof that the Worker has exited. */
  dispose(): Promise<void> {
    return this.disposal ??= (async () => {
      try { await this.request({ type: 'dispose' }); await this.exited }
      finally { await this.closeNative() }
    })()
  }
}
