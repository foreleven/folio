import {
  client, methods, PROTOCOL_VERSION, SessionUpdate,
  type ClientConnection, type Stream, type UpdateSessionNotification
} from '@agentclientprotocol/sdk/experimental/v2'
import { Effect, Schema } from 'effect'
import { randomUUID } from 'node:crypto'
import { RecordedUpdate } from '../../shared/harness-events'
import { NewRun } from '../../shared/harness'
import { HarnessStore } from './harness-store'
import { HarnessEventStore } from './harness-event-store'
import { auditAcpStream } from './acp-audit-stream'

/** Public transport failures do not expose protocol payloads or native diagnostics. */
export class HarnessClientError extends Schema.TaggedError<HarnessClientError>()('HarnessClientError', {
  reason: Schema.Literals(['closed', 'protocol', 'storage', 'busy', 'timeout']), message: Schema.String
}) {}
const failure = (reason: HarnessClientError['reason']) => new HarnessClientError({ reason, message: `Agent session connection failed (${reason}).` })

/** A resolve-only signal avoids unobserved rejections before a caller begins waiting. */
function signal<A>(): { promise: Promise<A>; resolve: (value: A) => void } {
  let resolve!: (value: A) => void
  const promise = new Promise<A>(complete => { resolve = complete })
  return { promise, resolve }
}

export interface HarnessAcpClientOptions {
  readonly stream: Stream
  readonly taskId: string
  readonly sessionId: string
  readonly cwd: string
  /** Called only after persistence; duplicate replay receipts never trigger a second live update. */
  readonly onUpdate?: (notification: UpdateSessionNotification) => Promise<void>
  readonly requestTimeoutMs?: number
  /** Stable transport identity shared with pre-handshake raw-byte diagnostics. */
  readonly connectionId?: string
}

/**
 * Connects one Folio Session to an already-owned ACP transport. The caller owns its process and
 * supplies a Vault scope that outlives this client. Opening an existing Session only replays history.
 * No process-death or Git-completion inference is made from the foreground idle notification.
 */
export const openHarnessAcpClient = Effect.fn('HarnessAcpClient.open')(function*(options: HarnessAcpClientOptions) {
  const store = yield* HarnessStore
  const events = yield* HarnessEventStore
  const task = yield* store.task(options.taskId)
  const saved = (yield* store.sessions(task.id)).find(session => session.id === options.sessionId)
  if (!saved) return yield* failure('protocol')
  const connectionId = options.connectionId ?? randomUUID()
  let acpSessionId: string | null = saved.acpSessionId
  let ready = false
  let closing = false
  let closePromise: Promise<void> | undefined
  let terminal: HarnessClientError | undefined
  const connectionRef: { current?: ClientConnection } = {}
  let queue = Promise.resolve()
  let buffered: UpdateSessionNotification[] = []
  const MAX_BUFFERED_UPDATES = 256
  let active: { id: string; dispatched: boolean; idle: ReturnType<typeof signal<UpdateSessionNotification>> } | undefined
  const failed = signal<HarnessClientError>()

  /** First failure poisons this connection; callers must explicitly inspect/recover uncertain Runs. */
  const stop = (error: HarnessClientError): void => {
    if (terminal) return
    terminal = error
    failed.resolve(error)
    connectionRef.current?.close()
  }
  /** Bounds protocol acknowledgement only, never the overall execution duration; no retries. */
  async function request<A>(work: Promise<A>): Promise<A> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([work, failed.promise.then(error => { throw error }), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { const error = failure('timeout'); stop(error); reject(error) }, options.requestTimeoutMs ?? 10_000)
      })])
    } finally { clearTimeout(timer) }
  }
  /** Serializes writes independently of SDK response dispatch, including updates arriving before session/new replies. */
  function receive(notification: UpdateSessionNotification, runId: string | null): void {
    const run = active
    queue = queue.then(async () => {
      if (terminal) throw terminal
      const input = Schema.decodeUnknownSync(RecordedUpdate)({ sessionId: saved!.id, runId, connectionId, notification }, { onExcessProperty: 'preserve' })
      const result = await Effect.runPromise(events.appendUpdate(input))
      if (!result.duplicate) {
        await options.onUpdate?.(notification)
        if (run && run.id === runId && SessionUpdate.isStateUpdate(notification.update) && notification.update.state === 'idle') {
          run.idle.resolve(notification)
        }
      }
    })
    // Notification handler rejection is not an ACP request response; explicitly close rather than let SDK log and continue.
    void queue.catch(() => stop(failure('storage')))
  }
  const app = client().onNotification(methods.client.session.update, ({ params }) => {
    if (!ready) {
      if (buffered.length >= MAX_BUFFERED_UPDATES) { stop(failure('protocol')); return }
      buffered.push(params)
    }
    else receive(params, active?.dispatched ? active.id : null)
  }).onRequest(methods.client.session.requestPermission, () => {
    // Full-access adapters must not wait on an invisible authorization flow.
    const error = failure('protocol')
    stop(error)
    throw error
  })
  const audit = auditAcpStream({ stream: options.stream, sessionId: saved.id, connectionId,
    runId: () => active?.dispatched ? active.id : null, stopped: () => terminal !== undefined,
    // Effect timeout interrupts the write and awaits its finalizers, unlike racing a detached Promise.
    append: frame => Effect.runPromise(events.appendProtocol(frame).pipe(Effect.timeout(options.requestTimeoutMs ?? 10_000))),
    onFailure: () => stop(failure('storage'))
  })
  const connection: ClientConnection = app.connect(audit)
  connectionRef.current = connection
  void connection.closed.then(() => { if (!closing) stop(failure('closed')) })

  /** Cancels and closes the protocol Session; the owning process scope must still verify worker exit. */
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      closing = true
      try {
        if (!terminal && acpSessionId) {
          if (active?.dispatched) await request(connection.agent.notify(methods.agent.session.cancel, { sessionId: acpSessionId }))
          await request(connection.agent.request(methods.agent.session.close, { sessionId: acpSessionId }))
          await request(queue)
        }
      } finally {
        stop(failure('closed'))
        connection.close()
        await connection.closed
        await audit.drain()
      }
    })()
    return closePromise
  }
  yield* Effect.addFinalizer(() => Effect.promise(() => close().catch(() => undefined)))

  yield* Effect.tryPromise({ try: async () => {
    const initialized = await request(connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION, info: { name: 'folio-harness', version: '0.1.0' }, capabilities: {}
    }))
    if (initialized.protocolVersion !== PROTOCOL_VERSION) throw failure('protocol')
    if (acpSessionId) {
      const restored = await request(connection.agent.request(methods.agent.session.resume, { sessionId: acpSessionId, cwd: options.cwd, replayFrom: { type: 'start' } }))
      const native = restored._meta?.['folio/nativeSessionId'] ?? null
      if (native !== saved.nativeSessionId) throw failure('protocol')
    } else {
      const created = await request(connection.agent.request(methods.agent.session.new, { cwd: options.cwd }))
      acpSessionId = created.sessionId
      const binding = Schema.decodeUnknownSync(Schema.Struct({ acpSessionId: Schema.NonEmptyString, nativeSessionId: Schema.NullOr(Schema.NonEmptyString) }))({
        acpSessionId, nativeSessionId: created._meta?.['folio/nativeSessionId'] ?? null
      })
      await Effect.runPromise(store.bindSession(saved.id, binding))
    }
    ready = true
    for (const notification of buffered) receive(notification, null)
    buffered = []
    await request(queue)
  }, catch: error => error instanceof HarnessClientError ? error : failure('protocol') }).pipe(
    Effect.tapError(error => Effect.sync(() => stop(error)))
  )

  return {
    connectionId,
    /** Persists the Run before dispatch; resolves only after idle is saved and the Prompt response is received. */
    prompt: async (input: NewRun, onReserved?: () => Promise<void>): Promise<UpdateSessionNotification> => {
      input = Schema.decodeUnknownSync(NewRun)(input)
      if (terminal || closing) throw terminal ?? failure('closed')
      if (active) throw failure('busy')
      if (input.taskId !== task.id || input.sessionId !== saved.id) throw failure('protocol')
      const run = { id: input.id, dispatched: false, idle: signal<UpdateSessionNotification>() }
      active = run
      try {
        await Effect.runPromise(store.reserveRun(input))
      } catch (error) { active = undefined; throw error }
      try {
        if (terminal || closing) throw terminal ?? failure('closed')
        await onReserved?.()
        if (terminal || closing) throw terminal ?? failure('closed')
        run.dispatched = true
        const acknowledged = request(connection.agent.request(methods.agent.session.prompt, {
          sessionId: acpSessionId!, prompt: [{ type: 'text', text: input.prompt }]
        })).then(() => Effect.runPromise(store.markRunning(input.id)))
        // Observe request failure immediately, even when the adapter reports idle before acknowledging.
        const [, idle] = await Promise.all([acknowledged, Promise.race([run.idle.promise, failed.promise.then(error => { throw error })])])
        return idle
      } catch (error) {
        stop(error instanceof HarnessClientError ? error : failure('protocol'))
        throw terminal
      } finally { active = undefined }
    },
    /** Cooperative cancellation; completion is still delivered by persisted idle, never inferred from notify success. */
    cancel: async (): Promise<void> => {
      if (terminal || closing) throw terminal ?? failure('closed')
      if (active?.dispatched) await request(connection.agent.notify(methods.agent.session.cancel, { sessionId: acpSessionId! }))
    },
    close
  }
})
