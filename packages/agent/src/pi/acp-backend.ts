import { RequestError, type SessionConfigOption } from "@agentclientprotocol/sdk/experimental/v2";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { makeSessionRegistry, SessionRegistryError, type SessionConfigSnapshot } from "../acp/session-registry.js";
import type { AcpSessionBackendFactory } from "../acp/session-backend.js";
import { makePiEventMapper } from "./event-mapper.js";
import type { PiSessionFactory } from "./session-factory.js";
import { PiSessionIdentity } from "./session-storage.js";

/** Preserves the existing stable ACP errors while keeping native Pi details behind the backend. */
const run = async <A>(effect: Effect.Effect<A, SessionRegistryError>): Promise<A> => {
  try { return await Effect.runPromise(effect); }
  catch (error) {
    if (!(error instanceof SessionRegistryError)) throw RequestError.internalError(undefined, "Session operation failed.");
    switch (error.reason) {
      case "session_not_found": case "session_closed": throw RequestError.resourceNotFound("session");
      case "session_busy": throw RequestError.invalidRequest({ reason: error.reason }, error.message);
      case "session_exists": case "config_option_unsupported": case "config_value_unsupported":
        throw RequestError.invalidParams({ reason: error.reason }, error.message);
      default: throw RequestError.internalError({ reason: error.reason }, error.message);
    }
  }
};

/** Builds the unchanged Pi model/thinking controls from its credential-free config snapshot. */
const configOptions = (snapshot: SessionConfigSnapshot): SessionConfigOption[] => [
  { type: "select", configId: "model", name: "Model", category: "model", currentValue: snapshot.modelValue,
    options: snapshot.models.map(({ value, name }) => ({ value, name })) },
  { type: "select", configId: "thought_level", name: "Thinking level", category: "thought_level", currentValue: snapshot.thinkingLevel,
    options: snapshot.thinkingLevels.map((value) => ({ value, name: value })) },
];

/** Adapts the existing Pi Registry to the shared ACP shell, including persisted terminal updates. */
export const makePiAcpBackend = (sessionFactory: PiSessionFactory, messageId: () => string = randomUUID): AcpSessionBackendFactory => ({
  agent: "pi",
  create: async ({ sessionId, cwd, resume, onUpdate }) => {
    if (resume !== undefined && !Schema.is(PiSessionIdentity)(resume)) {
      throw RequestError.invalidParams({ reason: "agent_mismatch" }, "The session belongs to another Agent.");
    }
    const mapper = makePiEventMapper({ createMessageId: messageId });
    const registry = makeSessionRegistry({ sessionFactory, onEvent: async (_id, event) => {
      for (const update of mapper.map(event)) await onUpdate(update);
    } });
    await run(registry.create(sessionId, cwd, resume));
    let foreground = false;
    let closed = false;
    let outputFailed = false;
    let completion: Promise<void> | undefined;
    let starting: Promise<void> | undefined;
    let closing: Promise<void> | undefined;

    /** Keeps a final update in the foreground boundary until it is durably delivered. */
    const ensureIdle = (): void => {
      if (closed || outputFailed) throw RequestError.resourceNotFound("session");
      if (foreground) throw RequestError.invalidRequest({ reason: "session_busy" }, "Session already has foreground work.");
    };
    /** A client can receive idle before the notification Promise settles; finish that delivery first. */
    const waitForFinalDelivery = async (): Promise<void> => {
      if (foreground && completion && (await run(registry.get(sessionId))).state === "idle") await completion;
    };
    return {
      processId: process.pid,
      native: () => run(registry.native(sessionId)),
      state: async () => closed || outputFailed ? "closed" : foreground ? "busy"
        : (await run(registry.get(sessionId))).state === "idle" ? "idle" : "busy",
      config: async () => configOptions(await run(registry.config(sessionId))),
      setConfig: async (id, value) => {
        await waitForFinalDelivery();
        ensureIdle();
        if (id !== "model" && id !== "thought_level") throw RequestError.invalidParams({ configId: id }, "Session configuration option is unsupported.");
        return configOptions(await run(registry.setConfig(sessionId, { configId: id, value })));
      },
      prompt: async (text, content) => {
        await waitForFinalDelivery();
        ensureIdle();
        foreground = true;
        starting = (async () => {
        try {
          const handle = await run(registry.prompt(sessionId, text, async () => {
            await onUpdate({ sessionUpdate: "user_message", messageId: messageId(), content });
            await onUpdate({ sessionUpdate: "state_update", state: "running" });
          }));
          completion = handle.completion.then(
            (stopReason) => onUpdate({ sessionUpdate: "state_update", state: "idle", stopReason }),
            () => onUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "refusal" }),
          ).catch(() => { outputFailed = true; }).finally(() => { foreground = false; });
        } catch (error) { foreground = false; throw error; }
        })();
        return starting;
      },
      cancel: async () => { await starting; await run(registry.cancel(sessionId)); await completion; },
      close: () => {
        closing ??= (async () => {
          closed = true;
          await starting?.catch(() => undefined);
          await run(registry.close(sessionId));
          await completion;
        })();
        return closing;
      },
    };
  },
});
