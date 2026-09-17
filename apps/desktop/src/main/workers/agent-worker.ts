import { parentPort } from 'node:worker_threads'
import { openAgentExecution, type AgentExecution, type PiToolResult } from '@folio/agent'
import type { AgentWorkerCommand, AgentWorkerEvent } from './agent-worker-protocol'

if (!parentPort) throw new Error('Agent execution requires a Worker thread.')
const port = parentPort
const send = (event: AgentWorkerEvent): void => port.postMessage(event)
let session: AgentExecution | undefined
let opening: Promise<AgentExecution> | undefined
let disposed = false
let sequence = 0
let nativeExited!: () => void
const nativeExit = new Promise<void>(resolve => { nativeExited = resolve })
const controller = new AbortController()
const tools = new Map<number, { resolve: (value: PiToolResult) => void; reject: (error: Error) => void; update?: (value: PiToolResult) => void }>()
const acknowledgements = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()

/** Commands stay concurrent so cancel/dispose can interrupt a pending execution or startup. */
async function handle(command: AgentWorkerCommand): Promise<void> {
  if (command.type === 'tool-result' || command.type === 'tool-update') {
    const pending = tools.get(command.sequence)
    if (command.type === 'tool-update') pending?.update?.(command.value)
    else {
      tools.delete(command.sequence)
      if (command.error || !command.value) pending?.reject(new Error(command.error ?? 'Host tool returned no result.'))
      else pending?.resolve(command.value)
    }
    return
  }
  if (command.type === 'native-exited') { nativeExited(); return }
  if (command.type === 'ack') {
    const pending = acknowledgements.get(command.sequence)
    acknowledgements.delete(command.sequence)
    if (command.error) pending?.reject(new Error(command.error))
    else pending?.resolve()
    return
  }
  try {
    let value: unknown
    switch (command.type) {
      case 'open': {
        if (opening || disposed) throw new Error('Worker already owns a Session.')
        opening = openAgentExecution({ ...command.options, signal: controller.signal,
          toolExecutor: (name, callId, params, signal, onUpdate) => {
            if (signal?.aborted) return Promise.reject(new Error('Tool execution cancelled.'))
            const id = ++sequence
            const abort = () => send({ type: 'tool-cancel', callId })
            signal?.addEventListener('abort', abort, { once: true })
            return new Promise<PiToolResult>((resolve, reject) => {
              tools.set(id, { resolve, reject, update: onUpdate })
              send({ type: 'tool', sequence: id, name, callId, params })
            }).finally(() => signal?.removeEventListener('abort', abort))
          },
          processTransport: command.native ? { ...command.native, exited: nativeExit,
            close: () => new Promise<void>((resolve, reject) => {
              const id = ++sequence
              acknowledgements.set(id, { resolve, reject })
              send({ type: 'native-close', sequence: id })
            })
          } : undefined,
          onSessionBound: nativeSessionId => new Promise<void>((resolve, reject) => {
            const id = ++sequence
            acknowledgements.set(id, { resolve, reject })
            send({ type: 'session-bound', sequence: id, nativeSessionId })
          }),
          onProcessStarted: command.native ? undefined : pid => new Promise<void>((resolve, reject) => {
            const id = ++sequence
            acknowledgements.set(id, { resolve, reject })
            send({ type: 'process-started', sequence: id, pid })
          }),
          onUpdate: notification => new Promise<void>((resolve, reject) => {
            const id = ++sequence
            acknowledgements.set(id, { resolve, reject })
            send({ type: 'update', sequence: id, notification })
          })
        })
        session = await opening
        value = { nativeSessionId: session.nativeSessionId, processId: session.processId }
        break
      }
      case 'execute':
        if (!session || disposed) throw new Error('Worker Session is unavailable.')
        value = await session.execute(command.prompt)
        break
      case 'cancel':
        if (!session) controller.abort()
        else await session.cancel()
        break
      case 'dispose':
        disposed = true
        controller.abort()
        await (session ?? await opening?.catch(() => undefined))?.dispose()
        break
    }
    send({ type: 'result', id: command.id, value })
    if (command.type === 'dispose') port.close()
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    send({ type: 'error', id: command.id, error: { name: failure.name, message: failure.message, stack: failure.stack } })
  }
}
port.on('message', (command: AgentWorkerCommand) => { void handle(command) })
