import type { AnyWireMessage } from '@agentclientprotocol/sdk/experimental/v2'
import { describe, expect, it, vi } from 'vitest'
import type { RecordedProtocolFrame } from '../../shared/harness-events'
import { auditAcpStream } from './acp-audit-stream'

/** Controlled transport proves ordering without starting an Agent or invoking a model. */
function fixture(append?: (frame: RecordedProtocolFrame) => Promise<void>) {
  const frames: RecordedProtocolFrame[] = []
  const sent: AnyWireMessage[] = []
  let source!: ReadableStreamDefaultController<AnyWireMessage>
  let run: string | null = 'first'
  const cancel = vi.fn()
  const failed = vi.fn()
  const stream = auditAcpStream({
    stream: { readable: new ReadableStream({ start(controller) { source = controller }, cancel }),
      writable: new WritableStream({ write(frame) { sent.push(frame) } }) },
    sessionId: 'session', connectionId: 'connection', runId: () => run, stopped: () => false,
    append: async frame => { await append?.(frame); frames.push(frame) }, onFailure: failed
  })
  return { frames, sent, source, cancel, failed, drain: stream.drain, reader: stream.readable.getReader(), writer: stream.writable.getWriter(),
    setRun(value: string | null) { run = value } }
}

/** A manually released persistence operation exposes forwarding/cancellation races deterministically. */
function gate() {
  let release!: () => void
  return { promise: new Promise<void>(resolve => { release = resolve }), release: () => release() }
}

describe('ACP wire audit boundary', () => {
  it('drains both in-flight directions before releasing the database and seals later writes', async () => {
    const wait = gate()
    const entered = vi.fn()
    const f = fixture(async () => { entered(); await wait.promise })
    const writing = f.writer.write({ jsonrpc: '2.0', method: 'outbound' })
    const rejected = expect(writing).rejects.toThrow('closed')
    f.source.enqueue({ jsonrpc: '2.0', method: 'inbound' })
    const reading = f.reader.read()
    await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(2))
    const drained = vi.fn()
    const closing = f.drain()
    expect(f.drain()).toBe(closing)
    void closing.then(drained)
    await f.reader.cancel()
    expect(drained).not.toHaveBeenCalled()
    wait.release()
    await closing
    await rejected
    await reading
    expect(f.frames).toHaveLength(2)
    expect(f.sent).toEqual([])
    expect(f.failed).not.toHaveBeenCalled()
    await expect(f.writer.write({ jsonrpc: '2.0', method: 'late' })).rejects.toThrow('closed')
    expect(entered).toHaveBeenCalledTimes(2)
  })

  it('persists both directions before forwarding and redacts only the audit copy', async () => {
    const wait = gate()
    const f = fixture(() => wait.promise)
    const request: AnyWireMessage = { jsonrpc: '2.0', id: 1, method: 'session/prompt', params: {
      api_key: 'private', nested: { Authorization: 'private', env: { TOKEN: 'private' } }, prompt: 'literal user text'
    } }
    const writing = f.writer.write(request)
    const reading = f.reader.read()
    const delivered = vi.fn()
    void reading.then(delivered)
    f.source.enqueue({ jsonrpc: '2.0', method: 'session/update', params: {} })
    await vi.waitFor(() => expect(f.sent).toEqual([]))
    expect(delivered).not.toHaveBeenCalled()
    wait.release()
    await writing
    await reading
    expect(f.sent).toEqual([request])
    expect(f.frames.find(frame => frame.direction === 'outbound')?.payload).toMatchObject({ params: {
      api_key: '[redacted]', nested: { Authorization: '[redacted]', env: '[redacted]' }, prompt: 'literal user text'
    } })
    await f.reader.cancel()
  })

  it('keeps batches atomic and attributes late replies by direction and typed request ID', async () => {
    const f = fixture()
    await f.writer.write([{ jsonrpc: '2.0', id: 1, method: 'one' }, { jsonrpc: '2.0', id: '1', method: 'string' }])
    f.setRun('second')
    f.source.enqueue({ jsonrpc: '2.0', id: 1, method: 'reverse' })
    await f.reader.read()
    await f.writer.write({ jsonrpc: '2.0', id: 1, result: {} })
    f.source.enqueue([{ jsonrpc: '2.0', id: '1', result: {} }, { jsonrpc: '2.0', id: 1, error: { code: -1, message: 'failed' } }])
    await f.reader.read()
    expect(f.frames).toHaveLength(4)
    expect(f.frames[2]?.associations).toMatchObject([{ method: 'reverse', runId: 'second' }])
    expect(f.frames[3]?.associations).toEqual([
      { kind: 'response', requestId: '1', method: 'string', runId: 'first' },
      { kind: 'error', requestId: 1, method: 'one', runId: 'first' }
    ])
    await f.reader.cancel()
  })

  it('does not guess the origin of duplicate outstanding IDs', async () => {
    const f = fixture()
    await f.writer.write({ jsonrpc: '2.0', id: 1, method: 'one' })
    f.setRun('second')
    await f.writer.write({ jsonrpc: '2.0', id: 1, method: 'two' })
    f.source.enqueue({ jsonrpc: '2.0', id: 1, result: {} })
    await f.reader.read()
    expect(f.frames.at(-1)?.associations).toMatchObject([{ method: null, runId: null }])
    await f.writer.write({ jsonrpc: '2.0', id: 1, method: 'reused' })
    f.source.enqueue({ jsonrpc: '2.0', id: 1, result: {} })
    await f.reader.read()
    expect(f.frames.at(-1)?.associations).toMatchObject([{ method: null, runId: null }])
    await f.reader.cancel()
  })

  it.each(['inbound', 'outbound'])('stops %s delivery on audit failure', async direction => {
    const f = fixture(async () => { throw new Error('disk failed') })
    const frame: AnyWireMessage = { jsonrpc: '2.0', method: 'test' }
    if (direction === 'outbound') await expect(f.writer.write(frame)).rejects.toThrow('disk failed')
    else {
      f.source.enqueue(frame)
      await expect(f.reader.read()).rejects.toThrow('disk failed')
      await vi.waitFor(() => expect(f.cancel).toHaveBeenCalled())
    }
    expect(f.sent).toEqual([])
    expect(f.failed).toHaveBeenCalledOnce()
    if (direction === 'outbound') await f.reader.cancel()
  })

  it('cancels during persistence without forwarding late requests', async () => {
    const wait = gate()
    const entered = vi.fn()
    const f = fixture(async () => { entered(); await wait.promise })
    const writing = f.writer.write({ jsonrpc: '2.0', id: 1, method: 'session/prompt' })
    const rejected = expect(writing).rejects.toThrow('closed')
    await vi.waitFor(() => expect(entered).toHaveBeenCalled())
    await f.reader.cancel()
    wait.release()
    await rejected
    expect(f.sent).toEqual([])
    expect(f.cancel).toHaveBeenCalledOnce()
  })

  it('cancels an inbound frame being persisted without delivering it or leaking a rejection', async () => {
    const wait = gate()
    const entered = vi.fn()
    const f = fixture(async () => { entered(); await wait.promise })
    f.source.enqueue({ jsonrpc: '2.0', method: 'session/update' })
    const reading = f.reader.read()
    await vi.waitFor(() => expect(entered).toHaveBeenCalled())
    await f.reader.cancel()
    wait.release()
    expect(await reading).toEqual({ value: undefined, done: true })
    await vi.waitFor(() => expect(f.frames).toHaveLength(1))
    expect(f.cancel).toHaveBeenCalledOnce()
  })
})
