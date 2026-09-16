import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Effect, Exit, Scope } from 'effect'
import { openAgentProcess, type AgentProcessOptions } from './agent-process'
import { openHarnessAcpClient, type HarnessAcpClientOptions } from './harness-acp-client'
import { HarnessStore } from './harness-store'
import { ExecutionEventSink } from './execution-event-sink'
import { HarnessStoreError } from '../../shared/harness'
import { hasExecutionProcess } from './execution-recovery'

export interface HarnessSessionOptions extends Omit<AgentProcessOptions, 'agent' | 'cwd' | 'modelProfile' | 'runtimeDirectory' | 'onMalformedInput'> {
  readonly taskId: string
  readonly sessionId: string
  /** Supplied only by the Vault-owned Session target resolver. */
  readonly cwd?: string
  readonly onUpdate?: HarnessAcpClientOptions['onUpdate']
  readonly requestTimeoutMs?: number
}

/**
 * Owns one Agent process and ACP client under a private Scope attached to the application/Vault scope.
 * Agent selection and cwd come from the ledger; explicit close completes process cleanup as well as
 * protocol shutdown. Resource ownership is independent of a renderer window or individual Prompt.
 */
export const openHarnessSession = Effect.fn('HarnessSession.open')(function*(options: HarnessSessionOptions) {
  const store = yield* HarnessStore
  const task = yield* store.task(options.taskId)
  const session = (yield* store.sessions(task.id)).find(row => row.id === options.sessionId)
  if (!session || task.state !== 'active' || task.worktreeState !== 'ready') return yield* new HarnessStoreError({ reason: 'invalid-state', message: 'This Task Session cannot be opened.' })
  const cwd = options.cwd ?? (session.purpose === 'task' ? task.worktree : null)
  if (!cwd) return yield* new HarnessStoreError({ reason: 'invalid-state', message: 'This Session execution target was not resolved.' })
  const scope = yield* Scope.make()
  const events = yield* ExecutionEventSink
  const connectionId = randomUUID()
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
  return yield* Effect.gen(function*() {
    let pid: number | undefined
    // Registered before the process/client finalizers, so this receipt follows their cleanup.
    yield* Effect.addFinalizer(() => pid !== undefined && !hasExecutionProcess(pid) ? events.processStopped(session.id).pipe(
      Effect.catch(() => Effect.logWarning('Process stopped; its durable receipt needs projection retry.'))
    ) : Effect.void)
    const process = yield* openAgentProcess({
      nodeExecutable: options.nodeExecutable, entrypoint: options.entrypoint, configDirectory: options.configDirectory,
      agentDirectory: options.agentDirectory, codexExecutable: options.codexExecutable,
      sessionStorageDirectory: options.sessionStorageDirectory,
      skillPaths: options.skillPaths,
      executableDirectories: options.executableDirectories,
      environment: options.environment,
      modelProfile: session.modelProfile ?? undefined,
      runtimeDirectory: join(options.sessionStorageDirectory ?? options.agentDirectory, 'runtime', session.id),
      agent: session.agent, cwd,
      onMalformedInput: diagnostic => Effect.runPromise(events.appendProtocolDiagnostic({
        sessionId: session.id, connectionId, direction: 'inbound', diagnostic
      }))
    })
    pid = process.pid
    // No ACP handshake/native Session may start before the process identity is durable.
    yield* events.processStarted(session.id, process.pid)
    const client = yield* openHarnessAcpClient({
      stream: process.stream, taskId: task.id, sessionId: session.id, cwd, onUpdate: options.onUpdate,
      requestTimeoutMs: options.requestTimeoutMs, connectionId
    })
    let closing: Promise<void> | undefined
    return {
      pid: process.pid, connectionId: client.connectionId, prompt: client.prompt, cancel: client.cancel,
      /** Coalesces shutdown; callers cannot mistake ACP close acknowledgement for a reaped process. */
      close: (): Promise<void> => closing ??= Effect.runPromise(Scope.close(scope, Exit.void))
    }
  }).pipe(
    Effect.provideService(Scope.Scope, scope),
    // Startup failure must release its partial process immediately even if the application scope remains open.
    Effect.onError(() => Scope.close(scope, Exit.void))
  )
})
