import { randomUUID } from 'node:crypto'
import { delimiter, join } from 'node:path'
import { Effect, Schema } from 'effect'
import { AgentWorkerPool, type WorkerLease } from './agent-worker-pool'
import { HarnessStore } from './harness-store'
import { ExecutionEventSink } from './execution-event-sink'
import { HarnessStoreError, NewRun } from '../../shared/harness'
import { RecordedUpdate } from '../../shared/harness-events'
import type { UpdateSessionNotification } from '@agentclientprotocol/sdk/experimental/v2'

export interface HarnessWorkerSessionOptions {
  readonly entrypoint: string
  readonly configDirectory: string
  readonly agentDirectory: string
  readonly sessionStorageDirectory?: string
  readonly codexExecutable?: string
  readonly skillPaths?: readonly string[]
  readonly executableDirectories?: readonly string[]
  readonly environment?: Readonly<Record<string, string>>
  readonly taskId: string
  readonly sessionId: string
  readonly cwd?: string
  readonly onUpdate?: (notification: UpdateSessionNotification) => Promise<void>
}


/** Host owns all Vault writes; the Worker only receives an immutable execution snapshot. */
export const openHarnessWorkerSession = Effect.fn('HarnessWorkerSession.open')(function* (options: HarnessWorkerSessionOptions) {
  const store = yield* HarnessStore
  const sink = yield* ExecutionEventSink
  const pool = yield* AgentWorkerPool
  const task = yield* store.task(options.taskId)
  const session = (yield* store.sessions(task.id)).find(value => value.id === options.sessionId)
  if (!session || task.state !== 'active' || task.worktreeState !== 'ready') {
    return yield* new HarnessStoreError({ reason: 'invalid-state', message: 'This Task Session cannot be opened.' })
  }
  const connectionId = randomUUID()
  const archiveId = session.acpSessionId ?? session.id
  let activeRun: string | null = null
  let lease: WorkerLease | undefined
  yield* Effect.addFinalizer(() => Effect.promise(async () => { await lease?.close() }))
  const guard = yield* sink.guard(session.id)
  const call = <A>(effect: Effect.Effect<A, HarnessStoreError>) => Effect.runPromise(guard(effect).pipe(
    // Interrupt and join failed storage operations before a later terminal receipt is published.
    Effect.timeout(10000), Effect.mapError(error => error instanceof HarnessStoreError ? error
      : new HarnessStoreError({ reason: 'storage', message: 'Worker event persistence timed out.' }))
  ))
  const workerOptions = {
    agent: session.agent, sessionId: archiveId, cwd: options.cwd ?? task.worktree,
    configDirectory: options.configDirectory, agentDirectory: options.agentDirectory,
    storageDirectory: options.sessionStorageDirectory ?? options.agentDirectory,
    runtimeDirectory: join(options.sessionStorageDirectory ?? options.agentDirectory, 'runtime', session.id),
    skillPaths: options.skillPaths, modelProfile: session.modelProfile ?? undefined,
    codexExecutable: options.codexExecutable, resume: session.acpSessionId !== null
  }
  return yield* Effect.tryPromise({ try: async () => {
    const environment = { ...process.env, ...options.environment,
      PATH: [...(options.executableDirectories ?? []), process.env.PATH ?? ''].join(delimiter) }
    await call(sink.workerStarting(session.id))
    lease = await pool.acquire({ entrypoint: options.entrypoint, options: workerOptions, environment,
      onSessionBound: async nativeSessionId => {
        if (session.nativeSessionId && session.nativeSessionId !== nativeSessionId) throw new Error('Native Session identity changed.')
        if (!session.acpSessionId) await call(sink.bindSession(session.id, { acpSessionId: archiveId, nativeSessionId }))
      },
      onStarted: id => call(sink.workerStarted(session.id, id)),
      onStopped: () => call(sink.workerStopped(session.id)),
      onProcessStarted: pid => call(sink.processStarted(session.id, pid)),
      onProcessStopped: pid => call(sink.processStopped(session.id, pid)),
      onUpdate: async notification => {
        await call(sink.appendUpdate(Schema.decodeUnknownSync(RecordedUpdate)({
          sessionId: session.id, connectionId, runId: activeRun, notification
        }, { onExcessProperty: 'preserve' })))
        if (options.onUpdate) { await call(sink.flush); await options.onUpdate(notification) }
      }
    })
    const binding = await lease.client.open(workerOptions)
    if (session.nativeSessionId && session.nativeSessionId !== binding.nativeSessionId) throw new Error('Native Session identity changed.')
    return {
      pid: binding.processId, connectionId,
      prompt: async (input: NewRun, onReserved?: () => Promise<void>, agentPrompt = input.prompt) => {
        if (activeRun) throw new Error('Worker already has an active execution.')
        if (input.taskId !== task.id || input.sessionId !== session.id) throw new Error('Execution does not belong to this Worker Session.')
        activeRun = input.id
        try {
          await call(sink.reserveRun(input))
          await onReserved?.()
          await call(sink.markRunning(input.id))
          return await lease!.client.execute(agentPrompt)
        } finally { activeRun = null }
      },
      cancel: () => lease!.client.cancel(),
      close: () => lease!.close()
    }
  }, catch: error => new HarnessStoreError({ reason: 'storage', message: error instanceof Error ? error.message : 'Agent Worker startup failed.' }) })
})
