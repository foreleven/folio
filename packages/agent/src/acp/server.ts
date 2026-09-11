import {
  PROTOCOL_VERSION, RequestError, SessionUpdate, agent, methods,
  type AgentApp, type AgentContext, type ContentBlock, type SessionInfo,
} from "@agentclientprotocol/sdk/experimental/v2";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { makePiAcpBackend } from "../pi/acp-backend.js";
import { makeFakePiSessionFactory } from "../pi/fake-session-factory.js";
import type { FakeModel } from "../pi/fake-model.js";
import type { PiSessionFactory } from "../pi/session-factory.js";
import { SessionLeaseError, type SessionLease } from "./session-lease.js";
import { SessionArchive } from "./session-archive.js";
import { nativeAgent, type AcpSessionBackend, type AcpSessionBackendFactory, type NativeSessionIdentity } from "./session-backend.js";

const AGENT_INFO = { name: "folio-agent", title: "Folio Agent", version: "0.1.0" } as const;
type SessionRecord = {
  readonly sessionId: string;
  readonly cwd: string;
  history: SessionUpdate[];
  client: AgentContext;
  updatedAt: string;
  nativeSessionId?: string;
  backend?: AcpSessionBackend;
  lease?: SessionLease;
  opening?: Promise<AcpSessionBackend>;
  readonly openingController: AbortController;
  /** Startup updates wait here until their archive header exists. */
  buffer?: SessionUpdate[];
  ready: boolean;
};

export interface FolioAgentOptions {
  readonly archive?: SessionArchive;
  /** Engine-specific process/lifecycle implementation; the wire shell and archive are shared. */
  readonly backendFactory?: AcpSessionBackendFactory;
  /** Pi SDK factory used by the default Pi backend. */
  readonly sessionFactory?: PiSessionFactory;
  readonly model?: FakeModel;
  readonly sessionId?: () => string;
  readonly messageId?: () => string;
  readonly log?: (message: string) => void;
}
export interface FolioAgentApp extends AgentApp {
  /** Waits for opening Sessions and closes every native backend. Safe to call repeatedly. */
  readonly shutdown: () => Promise<void>;
}

/** Validates the supported ACP workspace/request surface before starting an engine. */
const assertRoots = (cwd: string, additionalDirectories?: readonly string[]): void => {
  if (!isAbsolute(cwd)) throw RequestError.invalidParams({ cwd }, "cwd must be absolute");
  if ((additionalDirectories?.length ?? 0) > 0) {
    throw RequestError.invalidParams({ additionalDirectories: "unsupported" }, "Additional directories are unavailable.");
  }
};
/** The first release accepts text while retaining its original blocks in the message archive. */
const promptText = (blocks: readonly ContentBlock[]): string => blocks.map((block) => {
  if (block.type === "text") return block.text;
  throw RequestError.invalidParams({ type: block.type }, "Folio Agent currently supports text prompts only.");
}).join("\n");
const busy = () => RequestError.invalidRequest({ reason: "session_busy" }, "Session is busy.");
const requestError = (error: unknown): RequestError => error instanceof RequestError ? error
  : error instanceof SessionLeaseError && error.reason === "busy"
    ? RequestError.invalidRequest({ reason: "session_busy" }, error.message)
    : RequestError.internalError({ reason: "session_unavailable" }, "Session operation failed.");
const sessionInfo = (record: Pick<SessionRecord, "sessionId" | "cwd" | "updatedAt" | "nativeSessionId">): SessionInfo => ({
  sessionId: record.sessionId, cwd: record.cwd, updatedAt: record.updatedAt, additionalDirectories: [],
  ...(record.nativeSessionId ? { _meta: { "folio/nativeSessionId": record.nativeSessionId } } : {}),
});

/**
 * Owns ACP metadata, persistence and exact replay for every engine. Backends own execution, including
 * terminal updates; the shell never generates a second, competing completion state for a native Run.
 */
export const createFolioAgentApp = (options: FolioAgentOptions = {}): FolioAgentApp => {
  const factory = options.backendFactory ?? makePiAcpBackend(
    options.sessionFactory ?? makeFakePiSessionFactory({ model: options.model }), options.messageId,
  );
  const makeSessionId = options.sessionId ?? randomUUID;
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const records = new Map<string, SessionRecord>();
  const restoring = new Set<string>();
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;

  /** Archive before delivery; both fresh execution and recovery-state changes use this path. */
  const notify = async (record: SessionRecord, update: SessionUpdate): Promise<void> => {
    await options.archive?.append(record.sessionId, update);
    const sequence = record.history.push(update);
    record.updatedAt = new Date().toISOString();
    // Folio extension: immutable archive position, including on full replay. This is not an ACP cursor.
    await record.client.notify(methods.client.session.update, {
      sessionId: record.sessionId, update, _meta: { 'folio/eventSequence': sequence },
    });
  };
  /** Prevents access to Sessions whose native initialization or replay is still in progress. */
  const requireRecord = (id: string): SessionRecord & { backend: AcpSessionBackend } => {
    const record = records.get(id);
    if (shuttingDown || !record) throw RequestError.resourceNotFound("session");
    if (!record.ready || !record.backend || restoring.has(id)) throw busy();
    return record as SessionRecord & { backend: AcpSessionBackend };
  };
  /** Records startup ownership synchronously so shutdown cannot miss a process being opened. */
  const recordFor = (sessionId: string, cwd: string, client: AgentContext): SessionRecord => {
    if (shuttingDown) throw RequestError.invalidRequest(undefined, "Agent is shutting down.");
    const record: SessionRecord = { sessionId, cwd, client, history: [], updatedAt: new Date().toISOString(), buffer: [], ready: false,
      openingController: new AbortController() };
    records.set(sessionId, record);
    return record;
  };
  /** Starts/resumes an engine; it cannot write replay events until its immutable identity is archived. */
  const install = async (record: SessionRecord, resume?: NativeSessionIdentity): Promise<void> => {
    if (resume && nativeAgent(resume) !== factory.agent) {
      throw RequestError.invalidParams({ reason: "agent_mismatch" }, "The session belongs to another Agent.");
    }
    record.opening = (async () => {
      if (options.archive) record.lease = await options.archive.leases.acquire(record.sessionId, resume, { requireExistingStore: resume !== undefined });
      return factory.create({ sessionId: record.sessionId, cwd: record.cwd, resume, signal: record.openingController.signal, onUpdate: async (update) => {
        if (record.buffer) record.buffer.push(update);
        else await notify(record, update);
      } });
    })();
    record.backend = await record.opening;
    if (shuttingDown) throw RequestError.invalidRequest(undefined, "Agent is shutting down.");
    if (options.archive) {
      const native = await record.backend.native();
      if (nativeAgent(native) !== factory.agent || (resume && native.nativeSessionId !== resume.nativeSessionId)) {
        throw RequestError.internalError({ reason: "identity_mismatch" }, "Native session identity changed.");
      }
      await record.lease!.bind(native, record.backend.processId);
      record.nativeSessionId = native.nativeSessionId;
      if (!resume) await options.archive.create({ version: 1, sessionId: record.sessionId, cwd: record.cwd, native, createdAt: record.updatedAt });
    }
    while (record.buffer!.length) await notify(record, record.buffer!.shift()!);
    record.buffer = undefined;
    record.ready = true;
  };
  /** Closes a partially opened Session as well as one already usable by the protocol. */
  const release = async (record: SessionRecord): Promise<void> => {
    // Waiting for a hung native initialize before cancelling it would force the parent to kill the ACP
    // process first, potentially orphaning a worker whose PID has not yet been bound to the lease.
    record.openingController.abort();
    const backend = record.backend ?? await record.opening?.catch(() => undefined);
    await backend?.close();
    await record.lease?.release();
  };
  const shutdown = (): Promise<void> => {
    shuttingDown = true;
    shutdownPromise ??= (async () => {
      const results = await Promise.allSettled([...records.values()].map(release));
      records.clear();
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw requestError(failed.reason);
    })();
    return shutdownPromise;
  };

  const app = agent()
    .onConnect((connection) => { void connection.closed.then(shutdown, shutdown).catch(() => undefined); })
    .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, info: AGENT_INFO, capabilities: { session: {} } }))
    .onRequest(methods.agent.session.new, async ({ params, client }) => {
      assertRoots(params.cwd, params.additionalDirectories);
      if ((params.mcpServers?.length ?? 0) > 0) throw RequestError.invalidParams({ mcpServers: "unsupported" }, "MCP servers are unavailable.");
      const id = makeSessionId();
      if (records.has(id) || restoring.has(id)) throw RequestError.invalidRequest({ reason: "session_exists" }, "Session already exists.");
      const record = recordFor(id, params.cwd, client);
      try {
        await install(record);
        const configOptions = await record.backend!.config();
        log(`session created ${id}`);
        return { sessionId: id, _meta: sessionInfo(record)._meta, configOptions };
      } catch (error) {
        await release(record).catch(() => undefined);
        records.delete(id);
        throw requestError(error);
      }
    })
    .onRequest(methods.agent.session.list, async ({ params }) => {
      const sessions = options.archive
        ? (await options.archive.list()).filter(({ native }) => nativeAgent(native) === factory.agent)
          .map((header) => sessionInfo({ ...header, nativeSessionId: header.native.nativeSessionId }))
        : [...records.values()].filter((record) => record.ready).map(sessionInfo);
      return { sessions: sessions.filter((session) => params.cwd == null || session.cwd === params.cwd) };
    })
    .onRequest(methods.agent.session.resume, async ({ params, client }) => {
      assertRoots(params.cwd, params.additionalDirectories);
      if (params.replayFrom != null && params.replayFrom.type !== "start") {
        throw RequestError.invalidParams({ replayFrom: params.replayFrom }, "Folio Agent supports replayFrom: start only.");
      }
      if (restoring.has(params.sessionId)) throw busy();
      restoring.add(params.sessionId);
      let created: SessionRecord | undefined;
      try {
        let record = records.get(params.sessionId);
        if (!record && options.archive) {
          const archived = await options.archive.read(params.sessionId);
          if (params.cwd !== archived.header.cwd) throw RequestError.invalidParams({ reason: "cwd_mismatch" }, "cwd does not match the session");
          record = created = recordFor(params.sessionId, params.cwd, client);
          record.history = archived.history;
          await install(record, archived.header.native);
        }
        if (shuttingDown || !record) throw RequestError.resourceNotFound("session");
        if (!record.ready || !record.backend || await record.backend.state() !== "idle") throw busy();
        if (record.cwd !== params.cwd) throw RequestError.invalidParams({ reason: "cwd_mismatch" }, "cwd does not match the session");
        record.client = client;
        const lastState = record.history.slice().reverse().find(SessionUpdate.isStateUpdate);
        if (params.replayFrom?.type === "start") {
          for (const [index, update] of record.history.slice().entries()) await client.notify(methods.client.session.update, {
            sessionId: record.sessionId, update, _meta: { 'folio/eventSequence': index + 1 },
          });
        }
        // Recovery ends abandoned execution, but never resends its Prompt or writes replay a second time.
        if (lastState && lastState.state !== "idle") await notify(record, { sessionUpdate: "state_update", state: "idle", stopReason: "cancelled" });
        return { _meta: sessionInfo(record)._meta, configOptions: await record.backend.config() };
      } catch (error) {
        if (created) { await release(created).catch(() => undefined); records.delete(created.sessionId); }
        throw requestError(error);
      } finally { restoring.delete(params.sessionId); }
    })
    .onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
      const record = requireRecord(params.sessionId);
      if (params.type !== "id" || typeof params.value !== "string") throw RequestError.invalidParams({ type: params.type }, "Session configuration values must use IDs.");
      const configOptions = await record.backend.setConfig(params.configId, params.value);
      await notify(record, { sessionUpdate: "config_option_update", configOptions });
      return { configOptions };
    })
    .onRequest(methods.agent.session.prompt, async ({ params }) => {
      const record = requireRecord(params.sessionId);
      await record.backend.prompt(promptText(params.prompt), params.prompt);
      return {};
    })
    .onNotification(methods.agent.session.cancel, async ({ params }) => { await requireRecord(params.sessionId).backend.cancel(); })
    .onRequest(methods.agent.session.close, async ({ params }) => {
      const record = requireRecord(params.sessionId);
      record.ready = false;
      await release(record);
      records.delete(record.sessionId);
      log(`session closed ${record.sessionId}`);
      return {};
    });
  return Object.assign(app, { shutdown });
};
