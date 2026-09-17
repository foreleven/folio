import { type PiToolExecutor } from "../pi/host-tools.js";
import type { CodexProcessTransport } from "../codex/process-transport.js";
import { SessionUpdate, type UpdateSessionNotification } from "@agentclientprotocol/sdk/experimental/v2";
import { isAbsolute, join } from "node:path";
import { SessionArchive } from "../acp/session-archive.js";
import { nativeAgent, type AcpSessionBackend, type AcpSessionBackendFactory } from "../acp/session-backend.js";
import type { SessionLease } from "../acp/session-lease.js";
import { makeCodexAcpBackend } from "../codex/acp-backend.js";
import { makePiAcpBackend } from "../pi/acp-backend.js";
import type { ModelProfile } from "../config/schema.js";
import { makeFolioAgentRuntimeComposition } from "./composition.js";

export interface AgentExecutionOptions {
  readonly toolExecutor?: PiToolExecutor;
  readonly processTransport?: CodexProcessTransport;
  readonly agent: "pi" | "codex";
  readonly sessionId: string;
  readonly cwd: string;
  readonly configDirectory: string;
  readonly agentDirectory: string;
  readonly storageDirectory: string;
  readonly runtimeDirectory: string;
  readonly modelProfile?: ModelProfile;
  readonly skillPaths?: readonly string[];
  readonly codexExecutable?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly resume?: boolean;
  readonly signal?: AbortSignal;
  readonly onSessionBound?: (nativeSessionId: string) => Promise<void>;
  readonly onProcessStarted?: (pid: number) => Promise<void>;
  /** Resolves only after the host has durably accepted the event. */
  readonly onUpdate: (notification: UpdateSessionNotification) => Promise<void>;
}

export interface AgentExecution {
  readonly nativeSessionId: string;
  readonly processId: number;
  readonly execute: (prompt: string) => Promise<UpdateSessionNotification>;
  readonly cancel: () => Promise<void>;
  readonly dispose: () => Promise<void>;
}

/**
 * Direct SDK execution, independent of CLI/stdin/Electron. One owner controls one session.
 * Archive positions remain the event identities consumed by existing Vault projections.
 */
export async function openAgentExecution(
  options: AgentExecutionOptions,
  backendOverride?: AcpSessionBackendFactory,
): Promise<AgentExecution> {
  for (const path of [options.cwd, options.configDirectory, options.agentDirectory, options.storageDirectory, options.runtimeDirectory]) {
    if (!isAbsolute(path)) throw new Error("Agent execution requires absolute directories.");
  }
  if (options.signal?.aborted) throw new Error("Agent startup was cancelled.");
  let shutdownComposition = async (): Promise<void> => {};
  let factory = backendOverride;
  if (!factory) {
    if (options.agent === "codex") {
      factory = makeCodexAcpBackend({ processTransport: options.processTransport, executable: options.codexExecutable, skillPaths: options.skillPaths, onProcessStarted: options.onProcessStarted });
    } else {
      const profile = options.modelProfile;
      if (!profile) throw new Error("Pi execution requires the saved Session model profile.");
      const composition = makeFolioAgentRuntimeComposition({
        configDirectory: options.configDirectory, agentDirectory: options.agentDirectory,
        defaultProfile: profile,
        settings: { enabled: true, modelProfiles: [profile], defaultModelProfileId: profile.id },
      }, { toolExecutor: options.toolExecutor, skillPaths: options.skillPaths, env: options.environment,
        sessionDirectory: join(options.storageDirectory, "sessions"), runtimeDirectory: options.runtimeDirectory });
      shutdownComposition = composition.shutdown;
      factory = makePiAcpBackend(composition.sessionFactory);
    }
  }
  if (factory.agent !== options.agent) throw new Error("Agent backend does not match the saved Session.");
  const archive = new SessionArchive(join(options.storageDirectory, "acp-sessions"));
  let backend: AcpSessionBackend | undefined;
  let lease: SessionLease | undefined;
  let sequence = 0;
  let buffered: SessionUpdate[] | undefined = [];
  let output = Promise.resolve();
  let active: { resolve: (value: UpdateSessionNotification) => void; reject: (error: unknown) => void } | undefined;
  let poisoned: unknown;
  let closing: Promise<void> | undefined;
  const emit = (update: SessionUpdate): Promise<void> => {
    const next = output.then(async () => {
      if (poisoned) throw poisoned;
      await archive.append(options.sessionId, update);
      const notification = { sessionId: options.sessionId, update, _meta: { "folio/eventSequence": ++sequence } };
      await options.onUpdate(notification);
      if (SessionUpdate.isStateUpdate(update) && update.state === "idle") active?.resolve(notification);
    });
    // Some SDKs catch callback failures internally; also reject the caller's completion wait.
    output = next.catch(error => { poisoned = error; active?.reject(error); });
    return next;
  };
  const dispose = (): Promise<void> => closing ??= (async () => {
    try {
      await backend?.close();
      await output;
      await lease?.release();
    } finally {
      active?.reject(new Error("Agent execution closed before a terminal update."));
      await shutdownComposition();
    }
  })();
  try {
    const archived = options.resume ? await archive.read(options.sessionId) : undefined;
    if (archived && (archived.header.cwd !== options.cwd || nativeAgent(archived.header.native) !== options.agent)) {
      throw new Error("Saved Session identity does not match this execution.");
    }
    sequence = archived?.history.length ?? 0;
    lease = await archive.leases.acquire(options.sessionId, archived?.header.native, { requireExistingStore: !!archived });
    backend = await factory.create({
      sessionId: options.sessionId, cwd: options.cwd, resume: archived?.header.native, signal: options.signal,
      onUpdate: async update => {
        if (buffered) buffered.push(update);
        else await emit(update);
      },
    });
    if (options.signal?.aborted) throw new Error("Agent startup was cancelled.");
    const native = await backend.native();
    if (nativeAgent(native) !== options.agent || (archived && native.nativeSessionId !== archived.header.native.nativeSessionId)) {
      throw new Error("Native Session identity changed.");
    }
    await lease.bind(native, backend.processId);
    if (!archived) await archive.create({ version: 1, sessionId: options.sessionId, cwd: options.cwd, native, createdAt: new Date().toISOString() });
    await options.onSessionBound?.(native.nativeSessionId);
    // Replay is delivered with its original sequence, never appended or submitted as a prompt.
    for (const [index, update] of (archived?.history ?? []).entries()) {
      await options.onUpdate({ sessionId: options.sessionId, update, _meta: { "folio/eventSequence": index + 1 } });
    }
    while (buffered.length) await emit(buffered.shift()!);
    buffered = undefined;
    const lastState = archived?.history.slice().reverse().find(SessionUpdate.isStateUpdate);
    if (lastState && lastState.state !== "idle") {
      await emit({ sessionUpdate: "state_update", state: "idle", stopReason: "cancelled" });
    }
    return {
      nativeSessionId: native.nativeSessionId, processId: backend.processId,
      execute: async prompt => {
        if (closing || poisoned) throw poisoned ?? new Error("Agent execution is closed.");
        if (active) throw new Error("Agent execution is busy.");
        const terminal = new Promise<UpdateSessionNotification>((resolve, reject) => { active = { resolve, reject }; });
        try {
          const [, idle] = await Promise.all([
            backend!.prompt(prompt, [{ type: "text", text: prompt }]), terminal,
          ]);
          await output;
          if (poisoned) throw poisoned;
          return idle;
        } finally { active = undefined; }
      },
      cancel: () => backend!.cancel(),
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
