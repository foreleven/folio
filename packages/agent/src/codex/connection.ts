import type { CodexProcessTransport } from "./process-transport.js";
import { Deferred, Effect, Queue, Schema, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { isAbsolute } from "node:path";

const RequestId = Schema.Union([Schema.String, Schema.Int]);
const Envelope = Schema.Struct({
  id: Schema.optional(RequestId),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ code: Schema.Int, message: Schema.String })),
});
const InitializeResult = Schema.Struct({ userAgent: Schema.String });

/** Stable transport errors intentionally omit native diagnostics, paths and request payloads. */
export class CodexConnectionError extends Schema.TaggedError<CodexConnectionError>()("CodexConnectionError", {
  reason: Schema.Literals(["invalid_cwd", "spawn_failed", "closed", "protocol_error", "request_failed", "timeout"]),
  message: Schema.String,
}) {}

const failure = (reason: CodexConnectionError["reason"]) => new CodexConnectionError({
  reason, message: `Codex connection failed (${reason}).`,
});

export interface CodexServerEvent {
  /** Present for server-initiated requests; the adapter must respond instead of silently ignoring it. */
  readonly id?: string | number;
  readonly method: string;
  readonly params?: unknown;
}

export interface CodexConnectionOptions {
  readonly processTransport?: CodexProcessTransport;
  readonly cwd: string;
  /** Local installation or an explicitly supplied executable; never interpreted by a shell. */
  readonly executable?: string;
  /** Deadline for a protocol acknowledgement, not a limit on model/Task execution time. */
  readonly requestTimeoutMs?: number;
  /** Host persists ownership before any native handshake or prompt. */
  readonly onProcessStarted?: (pid: number) => Promise<void>;
}

/**
 * Opens one native app-server process in a Scope and completes its initialize handshake.
 * Responses are routed independently of notification consumption. The single event consumer owns
 * native event persistence and server requests. No requests are retried: a timed-out acknowledgement
 * can represent an operation already performed by Codex and terminates the connection.
 */
export const openCodexConnection = Effect.fn("CodexConnection.open")(function*(options: CodexConnectionOptions) {
  if (!isAbsolute(options.cwd)) return yield* failure("invalid_cwd");
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const outgoing = yield* Queue.unbounded<Uint8Array>();
  const events = yield* Queue.unbounded<CodexServerEvent, CodexConnectionError>();
  const pending = new Map<number, Deferred.Deferred<unknown, CodexConnectionError>>();
  let nextId = 0;
  let terminal: CodexConnectionError | undefined;
  const encoder = new TextEncoder();

  /** Ends all waiters on process/protocol failure; the first cause remains authoritative. */
  const terminate = Effect.fn("CodexConnection.terminate")(function*(error: CodexConnectionError) {
    if (terminal !== undefined) return;
    terminal = error;
    for (const deferred of pending.values()) yield* Deferred.fail(deferred, error);
    pending.clear();
    yield* Queue.fail(events, error);
    yield* Queue.shutdown(outgoing);
  });

  const transport = options.processTransport;
  if (transport) yield* Effect.addFinalizer(() => Effect.promise(transport.close));
  const child: {
    pid: number;
    stdin: Sink.Sink<void, Uint8Array, never, unknown>;
    stdout: Stream.Stream<Uint8Array, unknown>;
    stderr: Stream.Stream<Uint8Array, unknown>;
    exitCode: Effect.Effect<unknown, unknown>;
    kill: (options?: Parameters<ChildProcessSpawner.ChildProcessHandle["kill"]>[0]) => Effect.Effect<void, unknown>;
  } = transport ? {
    pid: transport.pid,
    stdin: Sink.fromWritableStream({ evaluate: () => transport.stdin, onError: () => failure("closed") }),
    stdout: Stream.fromReadableStream({ evaluate: () => transport.stdout, onError: () => failure("closed") }),
    stderr: Stream.fromReadableStream({ evaluate: () => transport.stderr, onError: () => failure("closed") }),
    exitCode: Effect.tryPromise({ try: () => transport.exited, catch: () => failure("closed") }),
    kill: (_options?: unknown) => Effect.tryPromise({ try: transport.close, catch: () => failure("closed") }),
  } : yield* spawner.spawn(ChildProcess.make(options.executable ?? "codex", [
    "app-server", "--listen", "stdio://",
    // Process-local override: selected Skills travel as explicit native inputs, not an inherited catalog.
    "--config", "skills.include_instructions=false",
  ], { cwd: options.cwd, forceKillAfter: "2 seconds" })).pipe(
    Effect.mapError(() => failure("spawn_failed")),
  );
  yield* Effect.addFinalizer(() => terminate(failure("closed")));
  if (options.onProcessStarted) yield* Effect.tryPromise({
    try: () => options.onProcessStarted!(child.pid), catch: () => failure("spawn_failed"),
  });

  /** Serializes complete NDJSON records through one stdin writer. */
  const send = Effect.fn("CodexConnection.send")(function*(message: unknown) {
    if (terminal !== undefined) return yield* terminal;
    const bytes = yield* Effect.try({
      try: () => encoder.encode(`${JSON.stringify(message)}\n`),
      catch: () => failure("protocol_error"),
    });
    if (!(yield* Queue.offer(outgoing, bytes))) return yield* terminal ?? failure("closed");
  });

  /** Decodes wire input before routing it; unexpected responses cannot be mistaken for success. */
  const receive = Effect.fn("CodexConnection.receive")(function*(line: string) {
    if (terminal !== undefined) return;
    const message = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Envelope))(line).pipe(
      Effect.mapError(() => failure("protocol_error")),
    );
    if (message.method !== undefined) {
      if ("result" in message || message.error !== undefined) return yield* failure("protocol_error");
      yield* Queue.offer(events, { id: message.id, method: message.method, params: message.params });
      return;
    }
    if (typeof message.id !== "number" || !("result" in message || message.error !== undefined)
      || ("result" in message && message.error !== undefined)) return yield* failure("protocol_error");
    const deferred = pending.get(message.id);
    if (deferred === undefined) return yield* failure("protocol_error");
    pending.delete(message.id);
    if (message.error !== undefined) yield* Deferred.fail(deferred, failure("request_failed"));
    else yield* Deferred.succeed(deferred, message.result);
  });

  /** Fails the connection and stops its process if any stream becomes unusable. */
  const onStreamFailure = (error: CodexConnectionError) => terminate(error).pipe(
    Effect.andThen(child.kill({ forceKillAfter: "2 seconds" })),
    Effect.catch(() => Effect.void),
  );
  yield* Stream.fromQueue(outgoing).pipe(Stream.run(child.stdin),
    Effect.catch(() => onStreamFailure(failure("closed"))), Effect.forkScoped);
  yield* child.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runForEach(receive),
    Effect.andThen(onStreamFailure(failure("closed"))),
    Effect.catch((error) => onStreamFailure(error instanceof CodexConnectionError ? error : failure("closed"))),
    Effect.forkScoped);
  // Drain stderr to prevent pipe backpressure, without copying account/config diagnostics to ACP.
  yield* child.stderr.pipe(Stream.runDrain,
    Effect.catch(() => onStreamFailure(failure("closed"))), Effect.forkScoped);
  yield* child.exitCode.pipe(Effect.andThen(terminate(failure("closed"))),
    Effect.catch(() => terminate(failure("closed"))), Effect.forkScoped);

  /** Waits only for this request's acknowledgement; interruption leaves its ID reserved until reply. */
  const request = Effect.fn("CodexConnection.request")(function*(method: string, params: unknown) {
    if (terminal !== undefined) return yield* terminal;
    const id = ++nextId;
    const startedAt = Date.now();
    yield* Effect.logInfo('Codex request started', { method, requestId: id, pid: child.pid });
    const deferred = yield* Deferred.make<unknown, CodexConnectionError>();
    pending.set(id, deferred);
    yield* send({ id, method, params }).pipe(Effect.tapError((error) => terminate(error)));
    return yield* Deferred.await(deferred).pipe(Effect.timeoutOrElse({
      duration: options.requestTimeoutMs ?? 10_000,
      orElse: () => onStreamFailure(failure("timeout")).pipe(Effect.andThen(Effect.fail(failure("timeout")))),
    }),
      Effect.tap(() => Effect.logInfo('Codex request completed', { method, requestId: id, pid: child.pid, elapsedMs: Date.now() - startedAt })),
      Effect.tapError(error => Effect.logWarning('Codex request failed', { method, requestId: id, pid: child.pid,
        reason: error.reason, elapsedMs: Date.now() - startedAt }))
    );
  });

  yield* Effect.gen(function*() {
    const initialized = yield* request("initialize", {
      clientInfo: { name: "folio", version: "0.1.0" },
      // Native background-terminal cleanup is experimental in Codex 0.153.4.
      capabilities: { experimentalApi: true },
    });
    yield* Schema.decodeUnknownEffect(InitializeResult)(initialized).pipe(
      Effect.mapError(() => failure("protocol_error")),
    );
    yield* send({ method: "initialized" });
  }).pipe(Effect.tapError(onStreamFailure));

  return {
    pid: child.pid,
    request,
    /** Explicitly terminates the native process; Scope closure also performs this cleanup. */
    close: onStreamFailure(failure("closed")),
    /** Sends an answer to a native server request, preserving its numeric or string ID. */
    respond: (id: string | number, result: unknown) => send({ id, result }),
    /** Rejects unsupported native requests explicitly so Codex does not wait indefinitely. */
    reject: (id: string | number) => send({ id, error: { code: -32601, message: "Unsupported request" } }),
    events: Stream.fromQueue(events),
  };
});
