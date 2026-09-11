import type { AnyWireMessage, Stream } from '@agentclientprotocol/sdk/experimental/v2'
import { Schema } from 'effect'
import type { ProtocolAssociation, RecordedProtocolFrame } from '../../shared/harness-events'

const JsonId = Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))
const sensitive = new Set(['authorization', 'apikey', 'accesstoken', 'refreshtoken', 'password', 'clientsecret', 'secret', 'cookie', 'setcookie', 'headers', 'env', 'environment'])

/** Redacts explicit credential containers; free-form prompts and tool text are intentionally preserved, not certified secret-free. */
function redact(value: Schema.Json): Schema.Json {
  if (Array.isArray(value)) return value.map(redact)
  if (Schema.is(Schema.JsonObject)(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    sensitive.has(key.toLowerCase().replace(/[-_]/g, '')) ? '[redacted]' : redact(entry)]))
  return value
}

/**
 * Audits decoded wire frames before forwarding them. Request IDs are connection/direction scoped,
 * and response attribution uses the originating request rather than whichever Run is active later.
 * This boundary cannot observe malformed NDJSON bytes rejected by the byte-stream decoder.
 */
export function auditAcpStream(options: {
  stream: Stream; sessionId: string; connectionId: string; runId: () => string | null;
  stopped: () => boolean; append: (frame: RecordedProtocolFrame) => Promise<void>; onFailure: () => void
}): Stream & { drain: () => Promise<void> } {
  const incoming = options.stream.readable.getReader()
  let cancelled = false
  let released = false
  const pending = new Set<Promise<void>>()
  let draining: Promise<void> | undefined
  /** Release once even when cancellation races a pending read. */
  function release() { if (!released) { released = true; incoming.releaseLock() } }
  const requests = { inbound: new Map<string, ProtocolAssociation | null>(), outbound: new Map<string, ProtocolAssociation | null>() }
  const closed = () => new Error('ACP audit stream is closed')

  /** One frame, including a whole batch, is persisted atomically; ambiguous IDs are never guessed. */
  async function record(direction: 'inbound' | 'outbound', frame: AnyWireMessage): Promise<void> {
    if (cancelled || options.stopped()) throw closed()
    try {
      const payload = Schema.decodeUnknownSync(Schema.Json)(frame)
      const items = Array.isArray(payload) && payload.length ? payload : [payload]
      const associations: ProtocolAssociation[] = items.map(item => {
        if (!Schema.is(Schema.JsonObject)(item) || item.jsonrpc !== '2.0') return { kind: 'invalid', requestId: null, method: null, runId: null }
        if (('id' in item && !Schema.is(JsonId)(item.id)) ||
          ('method' in item ? typeof item.method !== 'string' || 'result' in item || 'error' in item :
            !('id' in item) || ('result' in item) === ('error' in item))) {
          return { kind: 'invalid', requestId: null, method: null, runId: null }
        }
        if (typeof item.method === 'string') {
          const kind = 'id' in item ? 'request' : 'notification'
          const requestId = Schema.is(JsonId)(item.id) ? item.id : null
          const association: ProtocolAssociation = { kind, requestId, method: item.method, runId: options.runId() }
          if (kind === 'request') {
            const key = JSON.stringify(requestId)
            requests[direction].set(key, requests[direction].has(key) ? null : association)
          }
          return association
        }
        const key = JSON.stringify(Schema.is(JsonId)(item.id) ? item.id : null)
        const opposite = requests[direction === 'inbound' ? 'outbound' : 'inbound']
        const original = opposite.get(key)
        // Duplicate IDs leave an ambiguous tail: a later reply may still belong to either request.
        // Keep that ID poisoned for this connection instead of attributing a stale reply to reuse.
        if (original !== null) opposite.delete(key)
        return { kind: 'error' in item ? 'error' : 'result' in item ? 'response' : 'invalid',
          requestId: Schema.is(JsonId)(item.id) ? item.id : null, method: original?.method ?? null, runId: original?.runId ?? null }
      })
      const writing = options.append({ sessionId: options.sessionId, connectionId: options.connectionId, direction,
        payload: redact(payload), associations })
      pending.add(writing)
      try { await writing } finally { pending.delete(writing) }
    } catch (error) { options.onFailure(); throw error }
    // A successful write racing normal shutdown is not a storage failure.
    if (cancelled || options.stopped()) throw closed()
  }

  return {
    /** Seal admission and await every admitted write before the caller releases its database scope.
     * Append must settle only after its resources are released; the caller supplies its timeout.
     * Failures already invoke onFailure and are observed here without masking process cleanup.
     */
    drain() {
      cancelled = true
      return draining ??= Promise.allSettled([...pending]).then(() => undefined)
    },
    readable: new ReadableStream({
      async pull(controller) {
        try {
          const result = await incoming.read()
          if (cancelled) return
          if (result.done) { controller.close(); release(); return }
          await record('inbound', result.value)
          controller.enqueue(result.value)
        } catch (error) {
          if (!cancelled) controller.error(error)
          if (!released) { try { await incoming.cancel(error) } finally { release() } }
        }
      },
      async cancel(reason) { cancelled = true; try { await incoming.cancel(reason) } finally { release() } }
    }),
    writable: new WritableStream({
      async write(frame) {
        await record('outbound', frame)
        const writer = options.stream.writable.getWriter()
        try { await writer.write(frame) } finally { writer.releaseLock() }
      },
      async close() {
        const writer = options.stream.writable.getWriter()
        try { await writer.close() } finally { writer.releaseLock() }
      },
      async abort(reason) {
        const writer = options.stream.writable.getWriter()
        try { await writer.abort(reason) } finally { writer.releaseLock() }
      }
    })
  }
}
