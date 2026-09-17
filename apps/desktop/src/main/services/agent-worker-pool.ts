import { Context, Effect, Layer } from 'effect'
import { SessionLeaseStore } from '@folio/agent'
import { join } from 'node:path'
import { AgentWorkerClient } from '../workers/agent-worker-client'
import type { AgentWorkerOptions } from '../workers/agent-worker-protocol'
import type { UpdateSessionNotification } from '@agentclientprotocol/sdk/experimental/v2'
import { hasExecutionProcess } from './execution-recovery'

export interface WorkerLease {
  readonly client: AgentWorkerClient
  readonly threadId: number
  readonly close: () => Promise<void>
}
export interface WorkerAdmission {
  readonly entrypoint: string
  readonly environment?: NodeJS.ProcessEnv
  readonly options: AgentWorkerOptions
  readonly onStarted: (threadId: number) => Promise<void>
  readonly onStopped: () => Promise<void>
  readonly onSessionBound: (nativeSessionId: string) => Promise<void>
  readonly onProcessStarted: (pid: number) => Promise<void>
  readonly onProcessStopped: (pid: number) => Promise<void>
  readonly onUpdate: (notification: UpdateSessionNotification) => Promise<void>
}

/** Scheduler owns capacity from preparation through cleanup; this pool owns all actual threads. */
export class AgentWorkerPool extends Context.Service<AgentWorkerPool, {
  readonly acquire: (input: WorkerAdmission) => Promise<WorkerLease>
  readonly reconcile: (id: number) => Promise<void>
  readonly hasThread: (id: number) => boolean
}>()('folio/services/AgentWorkerPool') {
  static readonly layer = Layer.effect(AgentWorkerPool, Effect.gen(function* () {
    const leases = new Map<number, WorkerLease>()
    const alive = new Set<number>()
    let stopping = false
    yield* Effect.addFinalizer(() => Effect.promise(async () => {
      stopping = true
      const results = await Promise.allSettled([...leases.values()].map(lease => lease.close()))
      for (const result of results) if (result.status === 'rejected') console.error('[Folio][Worker] Shutdown cleanup failed', result.reason)
    }))
    return AgentWorkerPool.of({
      hasThread: id => alive.has(id),
      reconcile: async id => { if (!alive.has(id)) await leases.get(id)?.close() },
      acquire: async input => {
        if (stopping) throw new Error('Worker pool is shutting down.')
        const pids = new Set<number>()
        const recordedPids = new Set<number>()
        let workerRecorded = false
        const client = new AgentWorkerClient(input.entrypoint, input.onUpdate, input.environment, async nativePid => {
          pids.add(nativePid)
          await input.onProcessStarted(nativePid)
          recordedPids.add(nativePid)
        }, input.onSessionBound, async pid => {
          if (hasExecutionProcess(pid)) throw new Error('Tool process group has not exited.')
          await input.onProcessStopped(pid)
        })
        const threadId = client.worker.threadId
        alive.add(threadId)
        void client.exited.then(() => alive.delete(threadId))
        let closing: Promise<void> | undefined
        const lease: WorkerLease = { client, threadId, close: () => closing ??= (async () => {
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([client.dispose(), new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Worker cleanup timed out.')), 10_000)
            })])
          } catch (error) {
            console.error('[Folio][Worker] Cleanup requires forced thread exit', { threadId }, error)
            await client.worker.terminate()
            await client.exited
          } finally { clearTimeout(timer) }
          await client.closeNative()
          await client.drainEvents()
          if ([...pids].some(hasExecutionProcess)) throw new Error('Native Agent process group has not exited; ownership is retained.')
          // Called only after thread exit, and refuses to release a surviving native process.
          if (workerRecorded) {
            await new SessionLeaseStore(join(input.options.storageDirectory, 'acp-sessions')).releaseExitedThread(threadId)
          }
          for (const pid of recordedPids) await input.onProcessStopped(pid)
          if (workerRecorded) await input.onStopped()
          leases.delete(threadId)
        })().catch(error => { closing = undefined; throw error }) }
        leases.set(threadId, lease)
        try {
          await input.onStarted(threadId)
          workerRecorded = true
          return lease
        } catch (error) { await lease.close(); throw error }
      }
    })
  }))
}
