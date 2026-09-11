import type { ContentBlock, SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { Deferred, Effect, Schema, Semaphore, Stream } from "effect";
import { randomUUID } from "node:crypto";
import { openCodexSession, type CodexSessionOptions } from "./session.js";
import { mapCodexEvent } from "./event-mapper.js";
import type { CodexServerEvent } from "./connection.js";

const Turn = Schema.Struct({ id: Schema.NonEmptyString,
  status: Schema.Literals(["inProgress", "completed", "interrupted", "failed"]) });
const TurnResponse = Schema.Struct({ turn: Turn });
const TurnEvent = Schema.Struct({ threadId: Schema.String, turn: Turn });
const ItemEvent = Schema.Struct({ threadId: Schema.String, turnId: Schema.String });
export type CodexTurnOutcome = "end_turn" | "cancelled" | "failed";

/** Stable execution failures distinguish busy state from an unusable native process. */
export class CodexTurnError extends Schema.TaggedError<CodexTurnError>()("CodexTurnError", {
  reason: Schema.Literals(["busy", "closed", "protocol_error", "connection_failed", "output_failed", "unsupported_request", "cancel_timeout"]),
  message: Schema.String,
}) {}
const failure = (reason: CodexTurnError["reason"]) => new CodexTurnError({ reason, message: `Codex turn failed (${reason}).` });

interface ActiveTurn {
  id?: string;
  accepted: boolean;
  finishing: boolean;
  cancelRequested: boolean;
  interruptSent: boolean;
  outcome?: CodexTurnOutcome;
  readonly acknowledged: Deferred.Deferred<string, CodexTurnError>;
  readonly completed: Deferred.Deferred<CodexTurnOutcome, CodexTurnError>;
}

export interface CodexTurnRuntimeOptions extends CodexSessionOptions {
  /** Must resolve only after ACP output has been persisted/delivered; failure stops native execution. */
  readonly onUpdate: (update: SessionUpdate) => Promise<void>;
}

export interface CodexTurnRuntime {
  readonly processId: number;
  readonly nativeSessionId: string;
  readonly model: string;
  readonly provider: string;
  readonly prompt: (text: string, displayContent?: ContentBlock[]) => Effect.Effect<{
    nativeTurnId: string; completion: Effect.Effect<CodexTurnOutcome, CodexTurnError>;
  }, CodexTurnError>;
  readonly cancel: Effect.Effect<void, CodexTurnError>;
  readonly close: Effect.Effect<void>;
  readonly state: Effect.Effect<"idle" | "closed" | "starting" | "running" | "cancelling">;
}

/**
 * Opens one native Session and serializes its prompt lifecycle. A start acknowledgement never means
 * completion: execution is released only after a matching turn/completed and output delivery.
 * A server completion arriving before its start response is retained until both agree on identity.
 */
export const openCodexTurnRuntime = Effect.fn("CodexTurnRuntime.open")(function*(options: CodexTurnRuntimeOptions) {
  const session = yield* openCodexSession(options);
  const { connection, nativeSessionId } = session;
  const outputLock = yield* Semaphore.make(1);
  const stopped = yield* Deferred.make<void>();
  let active: ActiveTurn | undefined;
  let terminal: CodexTurnError | undefined;

  /** The output sink is part of execution success, rather than a best-effort UI side effect. */
  const deliver = (update: SessionUpdate) => Effect.tryPromise({
    try: () => options.onUpdate(update), catch: () => failure("output_failed"),
  });
  const emit = (update: SessionUpdate) => outputLock.withPermit(Effect.suspend(() =>
    terminal === undefined ? deliver(update) : Effect.fail(terminal)));


  /** Stops native execution before rejecting completion; never retries an uncertain operation. */
  const stop = Effect.fn("CodexTurnRuntime.stop")(function*(error: CodexTurnError) {
    if (terminal !== undefined) return yield* Deferred.await(stopped);
    terminal = error;
    // Codex command terminals can own separate process groups and survive app-server exit.
    // Ask their native owner to stop them while transport is still usable. A failed/crashed
    // transport still needs forced close; neither this acknowledgement nor close proves that
    // arbitrary detached writers have stopped, so no synchronization safety is inferred here.
    yield* connection.request("thread/backgroundTerminals/clean", { threadId: nativeSessionId }).pipe(
      Effect.catch(() => Effect.void),
    );
    yield* connection.close;
    const run = active;
    active = undefined;
    if (run !== undefined) {
      if (error.reason !== "output_failed") {
        yield* outputLock.withPermit(deliver({ sessionUpdate: "state_update", state: "idle", stopReason: error.reason === "closed" ? "cancelled" : "refusal",
          // ACP stop reasons do not distinguish transport loss from a completed model refusal.
          _meta: { "folio/executionInterrupted": true } })).pipe(Effect.catch(() => Effect.void));
      }
      yield* Deferred.fail(run.acknowledged, error);
      yield* Deferred.fail(run.completed, error);
    }
    yield* Deferred.succeed(stopped, undefined);
  }, Effect.uninterruptible);
  yield* Effect.addFinalizer(() => stop(failure("closed")));

  /** Rejects a response/notification referring to another turn before it can release this Run. */
  const bind = (run: ActiveTurn, id: string) => Effect.suspend(() => {
    if (run.id !== undefined && run.id !== id) return Effect.fail(failure("protocol_error"));
    run.id = id;
    return Effect.void;
  });

  /** Atomically claims finalization, then waits for the last persisted update before allowing another prompt. */
  const finish = Effect.fn("CodexTurnRuntime.finish")(function*(run: ActiveTurn) {
    if (!run.accepted || run.outcome === undefined || run.finishing || active !== run) return;
    run.finishing = true;
    yield* emit({ sessionUpdate: "state_update", state: "idle",
      stopReason: run.outcome === "failed" ? "refusal" : run.outcome });
    if (terminal !== undefined || active !== run) return;
    active = undefined;
    yield* Deferred.succeed(run.completed, run.outcome);
  });

  /** Consumes native notifications in order; request responses use the connection's independent router. */
  const receive = Effect.fn("CodexTurnRuntime.receive")(function*(event: CodexServerEvent) {
    if (terminal !== undefined) return;
    if (event.id !== undefined) {
      // V1 has no authorization-wait state or interactive native input UI.
      yield* connection.reject(event.id).pipe(Effect.mapError(() => terminal ?? failure("connection_failed")));
      return yield* failure("unsupported_request");
    }
    if (event.method === "turn/started" || event.method === "turn/completed") {
      const params = yield* Schema.decodeUnknownEffect(TurnEvent)(event.params).pipe(Effect.mapError(() => failure("protocol_error")));
      if (params.threadId !== nativeSessionId) return;
      const run = active;
      if (run === undefined) return yield* failure("protocol_error");
      yield* bind(run, params.turn.id);
      if (event.method === "turn/completed") {
        if (params.turn.status === "inProgress" || run.outcome !== undefined) return yield* failure("protocol_error");
        run.outcome = params.turn.status === "completed" ? "end_turn" : params.turn.status === "interrupted" ? "cancelled" : "failed";
        yield* finish(run);
      }
      return;
    }
    if (event.method.startsWith("item/")) {
      const params = yield* Schema.decodeUnknownEffect(ItemEvent)(event.params).pipe(Effect.mapError(() => failure("protocol_error")));
      if (params.threadId !== nativeSessionId) return;
      if (active === undefined || active.outcome !== undefined) return yield* failure("protocol_error");
      yield* bind(active, params.turnId);
      const updates = yield* mapCodexEvent(event).pipe(Effect.mapError(() => failure("protocol_error")));
      for (const update of updates) yield* emit(update);
    }
  });
  yield* connection.events.pipe(Stream.runForEach(receive),
    Effect.catch((error) => stop(error instanceof CodexTurnError ? error : failure("connection_failed"))),
    Effect.forkScoped);

  /** Reserves the Session before I/O, then sends one prompt and returns its separately awaited completion. */
  const prompt = Effect.fn("CodexTurnRuntime.prompt")(function*(text: string, displayContent?: ContentBlock[]) {
    const run = yield* Effect.suspend(() => {
      if (terminal !== undefined) return Effect.fail(terminal);
      if (active !== undefined) return Effect.fail(failure("busy"));
      active = { accepted: false, finishing: false, cancelRequested: false, interruptSent: false,
        acknowledged: Deferred.makeUnsafe(), completed: Deferred.makeUnsafe() };
      return Effect.succeed(active);
    });
    return yield* Effect.gen(function*() {
      yield* emit({ sessionUpdate: "user_message", messageId: randomUUID(), content: displayContent ?? [{ type: "text", text }] });
      yield* emit({ sessionUpdate: "state_update", state: "running" });
      const response = yield* connection.request("turn/start", {
        threadId: nativeSessionId, input: [{ type: "text", text, text_elements: [] }, ...session.skills],
      }).pipe(Effect.mapError(() => terminal ?? failure("connection_failed")),
        Effect.flatMap((value) => Schema.decodeUnknownEffect(TurnResponse)(value).pipe(
          Effect.mapError(() => failure("protocol_error")),
        )));
      yield* bind(run, response.turn.id);
      run.accepted = true;
      yield* Deferred.succeed(run.acknowledged, response.turn.id);
      yield* finish(run);
      return { nativeTurnId: response.turn.id, completion: Deferred.await(run.completed) };
    }).pipe(Effect.tapError(stop), Effect.onInterrupt(() => stop(failure("closed"))));
  });

  /** Cancels a starting/running turn once, waiting for native completion rather than only interrupt acknowledgement. */
  const cancel = Effect.fn("CodexTurnRuntime.cancel")(function*() {
    if (terminal !== undefined) return yield* terminal;
    const run = active;
    if (run === undefined) return;
    run.cancelRequested = true;
    yield* Effect.gen(function*() {
      const turnId = yield* Deferred.await(run.acknowledged);
      if (active !== run) return;
      if (run.outcome === undefined && !run.interruptSent) {
        run.interruptSent = true;
        yield* connection.request("turn/interrupt", { threadId: nativeSessionId, turnId }).pipe(
          Effect.mapError(() => terminal ?? failure("connection_failed")),
        );
      }
      yield* Deferred.await(run.completed).pipe(Effect.timeoutOrElse({
        duration: options.requestTimeoutMs ?? 10_000,
        orElse: () => Effect.fail(failure("cancel_timeout")),
      }));
    }).pipe(Effect.tapError(stop), Effect.onInterrupt(() => stop(failure("closed"))));
  });

  const runtime: CodexTurnRuntime = {
    processId: connection.pid,
    nativeSessionId, model: session.model, provider: session.provider,
    prompt, cancel: cancel(), close: stop(failure("closed")),
    /** A snapshot for callers; only completion, not this observation, releases execution ownership. */
    state: Effect.sync(() => terminal !== undefined ? "closed" as const : active === undefined ? "idle" as const
      : active.cancelRequested ? "cancelling" as const : active.accepted ? "running" as const : "starting" as const),
  };
  return runtime;
});
