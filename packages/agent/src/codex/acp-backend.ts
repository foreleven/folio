import type { CodexProcessTransport } from "./process-transport.js";
import { RequestError, SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Schema, Scope } from "effect";
import { CodexSessionIdentity, type AcpSessionBackendFactory } from "../acp/session-backend.js";
import { openCodexTurnRuntime, CodexTurnError, type CodexTurnRuntimeOptions } from "./turn-runtime.js";

export interface CodexAcpBackendOptions {
  readonly processTransport?: CodexProcessTransport;
  readonly executable?: string;
  readonly skillPaths?: readonly string[];
  readonly onProcessStarted?: (pid: number) => Promise<void>;
  /** Subprocess test seam; production always uses the native Turn runtime. */
  readonly acquire?: (options: CodexTurnRuntimeOptions) => ReturnType<typeof openCodexTurnRuntime>;
}

/** Converts native runtime errors to stable ACP failures without forwarding native diagnostic payloads. */
const run = async <A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal): Promise<A> => {
  try { return await Effect.runPromise(effect, { signal }); }
  catch (error) {
    if (error instanceof CodexTurnError && error.reason === "busy") {
      throw RequestError.invalidRequest({ reason: "session_busy" }, "Session is busy.");
    }
    throw RequestError.internalError({ reason: "session_unavailable" }, "Codex session operation failed.");
  }
};

/** Owns one Effect Scope / native process per ACP Session; all Runs reuse that process until close. */
export const makeCodexAcpBackend = (options: CodexAcpBackendOptions = {}): AcpSessionBackendFactory => ({
  agent: "codex",
  create: async ({ cwd, resume, onUpdate, signal }) => {
    if (resume !== undefined && !Schema.is(CodexSessionIdentity)(resume)) {
      throw RequestError.invalidParams({ reason: "agent_mismatch" }, "The session belongs to another Agent.");
    }
    const scope = await Effect.runPromise(Scope.make());
    let closing: Promise<void> | undefined;
    // A Scope survives the create request; closing it also waits for native process finalizers.
    const close = (): Promise<void> => {
      closing ??= Effect.runPromise(Scope.close(scope, Exit.void));
      return closing;
    };
    let finalizing = false;
    let completion: Promise<void> | undefined;
    try {
      const runtime = await run((options.acquire ?? openCodexTurnRuntime)({
        cwd, processTransport: options.processTransport, nativeSessionId: resume?.nativeSessionId, executable: options.executable, skillPaths: options.skillPaths, onProcessStarted: options.onProcessStarted, onUpdate: async (update) => {
          if (SessionUpdate.isStateUpdate(update) && update.state === "idle") finalizing = true;
          await onUpdate(update);
        },
      }).pipe(Effect.provideService(Scope.Scope, scope), Effect.provide(NodeServices.layer)), signal);
      return {
        processId: runtime.processId,
        native: async () => ({ agent: "codex", nativeSessionId: runtime.nativeSessionId }),
        state: async () => {
          const state = await run(runtime.state);
          return state === "idle" || state === "closed" ? state : "busy";
        },
        // The local Codex config supplies its model until native config controls are wired explicitly.
        config: async () => [],
        setConfig: async () => { throw RequestError.invalidParams({ reason: "config_option_unsupported" }, "Codex configuration controls are not available."); },
        prompt: async (text, content) => {
          // Receiving idle can precede resolution of the transport notification Promise.
          if (finalizing) await completion;
          const handle = await run(runtime.prompt(text, content));
          completion = Effect.runPromise(handle.completion).then(() => undefined, () => undefined)
            .finally(() => { finalizing = false; });
        },
        cancel: () => run(runtime.cancel),
        close,
      };
    } catch (error) { await close(); throw error; }
  },
});
