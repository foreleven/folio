import {
  PROTOCOL_VERSION,
  RequestError,
  agent,
  methods,
  type AgentApp,
  type AgentContext,
  type ContentBlock,
  type SessionConfigOption,
  type SessionInfo,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  makeSessionRegistry,
  SessionRegistryError,
  type SessionConfigSnapshot,
  type SessionRegistry,
} from "./session-registry.js";
import { makePiEventMapper, type PiEventMapper } from "../pi/event-mapper.js";
import { makeFakePiSessionFactory } from "../pi/fake-session-factory.js";
import type { FakeModel } from "../pi/fake-model.js";
import type { PiSessionFactory } from "../pi/session-factory.js";

const AGENT_INFO = {
  name: "folio-agent",
  title: "Folio Agent",
  version: "0.1.0",
} as const;

type SessionRecord = {
  readonly sessionId: string;
  readonly cwd: string;
  readonly history: SessionUpdate[];
  readonly mapper: PiEventMapper;
  readonly client: AgentContext;
  updatedAt: string;
};

export interface FolioAgentOptions {
  /** Production passes a real Pi factory; the default remains a no-network contract adapter. */
  readonly sessionFactory?: PiSessionFactory;
  /** Compatibility seam for existing fake-model contract tests. */
  readonly model?: FakeModel;
  readonly sessionId?: () => string;
  readonly messageId?: () => string;
  readonly log?: (message: string) => void;
}

export interface FolioAgentApp extends AgentApp {
  /** Cancels and releases every registered Pi session. Safe to call repeatedly. */
  readonly shutdown: () => Promise<void>;
}

const assertAbsolute = (path: string, label: string): void => {
  if (!isAbsolute(path)) {
    throw RequestError.invalidParams({ [label]: path }, `${label} must be absolute`);
  }
};

const assertSupportedSessionRoots = (additionalDirectories: readonly string[] | undefined): void => {
  if ((additionalDirectories?.length ?? 0) > 0) {
    throw RequestError.invalidParams(
      { additionalDirectories: "unsupported" },
      "Additional directories are unavailable until workspace policy is enabled.",
    );
  }
};

const assertSupportedMcp = (mcpServers: readonly unknown[] | undefined): void => {
  if ((mcpServers?.length ?? 0) > 0) {
    throw RequestError.invalidParams(
      { mcpServers: "unsupported" },
      "MCP servers are unavailable until the permission boundary is enabled.",
    );
  }
};

const promptText = (blocks: readonly ContentBlock[]): string =>
  blocks
    .map((block) => {
      if (block.type === "text") return block.text;
      throw RequestError.invalidParams(
        { type: block.type },
        "Folio Agent currently supports text prompts only.",
      );
    })
    .join("\n");

const registryRequestError = (error: unknown): RequestError => {
  if (!(error instanceof SessionRegistryError)) {
    return RequestError.internalError({ reason: "session_unavailable" }, "Session operation failed.");
  }
  switch (error.reason) {
    case "session_not_found":
    case "session_closed":
      return RequestError.resourceNotFound("session");
    case "session_busy":
      return RequestError.invalidRequest({ reason: error.reason }, error.message);
    case "session_exists":
    case "config_option_unsupported":
    case "config_value_unsupported":
      return RequestError.invalidParams({ reason: error.reason }, error.message);
    case "session_unavailable":
    case "prompt_failed":
    case "config_update_failed":
      return RequestError.internalError({ reason: error.reason }, error.message);
  }
};

const runRegistry = async <A>(effect: Effect.Effect<A, SessionRegistryError>): Promise<A> => {
  try {
    return await Effect.runPromise(effect);
  } catch (error) {
    throw registryRequestError(error);
  }
};

const sessionConfigOptions = (snapshot: SessionConfigSnapshot): SessionConfigOption[] => [
  {
    type: "select",
    configId: "model",
    name: "Model",
    category: "model",
    currentValue: snapshot.modelValue,
    options: snapshot.models.map(({ value, name }) => ({ value, name })),
  },
  {
    type: "select",
    configId: "thought_level",
    name: "Thinking level",
    category: "thought_level",
    currentValue: snapshot.thinkingLevel,
    options: snapshot.thinkingLevels.map((value) => ({ value, name: value })),
  },
];

const sessionInfo = (session: SessionRecord): SessionInfo => ({
  sessionId: session.sessionId,
  cwd: session.cwd,
  additionalDirectories: [],
  updatedAt: session.updatedAt,
});

/**
 * Builds the ACP v2 protocol shell around one Session Registry. The Registry is the sole owner of
 * prompt concurrency, cancellation, Pi subscriptions and disposal; this layer owns only wire
 * metadata and replay history.
 */
export const createFolioAgentApp = (options: FolioAgentOptions = {}): FolioAgentApp => {
  const makeSessionId = options.sessionId ?? randomUUID;
  const makeMessageId = options.messageId ?? randomUUID;
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const records = new Map<string, SessionRecord>();
  const sessionFactory = options.sessionFactory ?? makeFakePiSessionFactory({ model: options.model });

  const notify = async (record: SessionRecord, update: SessionUpdate): Promise<void> => {
    record.history.push(update);
    record.updatedAt = new Date().toISOString();
    await record.client.notify(methods.client.session.update, {
      sessionId: record.sessionId,
      update,
    });
  };

  const registry: SessionRegistry = makeSessionRegistry({
    sessionFactory,
    onEvent: async (sessionId, event) => {
      const record = records.get(sessionId);
      if (record === undefined) return;
      for (const update of record.mapper.map(event)) {
        await notify(record, update);
      }
    },
  });

  const requireRecord = (sessionId: string): SessionRecord => {
    const record = records.get(sessionId);
    if (record === undefined) throw RequestError.resourceNotFound("session");
    return record;
  };

  const shutdown = async (): Promise<void> => {
    await Effect.runPromise(registry.shutdown);
    records.clear();
  };

  const app = agent()
    .onConnect((connection) => {
      void connection.closed.then(shutdown, shutdown).catch(() => undefined);
    })
    .onRequest(methods.agent.initialize, ({ params }) => ({
      protocolVersion: params.protocolVersion === PROTOCOL_VERSION ? params.protocolVersion : PROTOCOL_VERSION,
      info: AGENT_INFO,
      capabilities: { session: {} },
    }))
    .onRequest(methods.agent.session.new, async ({ params, client }) => {
      assertAbsolute(params.cwd, "cwd");
      assertSupportedSessionRoots(params.additionalDirectories);
      assertSupportedMcp(params.mcpServers);
      const sessionId = makeSessionId();
      const record: SessionRecord = {
        sessionId,
        cwd: params.cwd,
        history: [],
        mapper: makePiEventMapper({ createMessageId: makeMessageId }),
        client,
        updatedAt: new Date().toISOString(),
      };
      records.set(sessionId, record);
      try {
        await runRegistry(registry.create(sessionId, params.cwd));
      } catch (error) {
        records.delete(sessionId);
        throw error;
      }
      log(`session created ${sessionId}`);
      return {
        sessionId,
        configOptions: sessionConfigOptions(await runRegistry(registry.config(sessionId))),
      };
    })
    .onRequest(methods.agent.session.list, ({ params }) => ({
      sessions: registry.list()
        .filter((session) => params.cwd == null || params.cwd === session.cwd)
        .map(({ sessionId }) => sessionInfo(requireRecord(sessionId))),
    }))
    .onRequest(methods.agent.session.resume, async ({ params, client }) => {
      assertAbsolute(params.cwd, "cwd");
      assertSupportedSessionRoots(params.additionalDirectories);
      const record = requireRecord(params.sessionId);
      await runRegistry(registry.get(params.sessionId));
      if (params.cwd !== record.cwd) {
        throw RequestError.invalidParams({ cwd: params.cwd }, "cwd does not match the session");
      }
      if (params.replayFrom?.type === "start") {
        for (const update of record.history) {
          await client.notify(methods.client.session.update, { sessionId: record.sessionId, update });
        }
      } else if (params.replayFrom != null) {
        throw RequestError.invalidParams(
          { replayFrom: params.replayFrom },
          "Folio Agent supports replayFrom: start only.",
        );
      }
      return {
        configOptions: sessionConfigOptions(await runRegistry(registry.config(record.sessionId))),
      };
    })
    .onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
      const record = requireRecord(params.sessionId);
      if (params.type !== "id" || typeof params.value !== "string") {
        throw RequestError.invalidParams({ type: params.type }, "Session configuration values must use IDs.");
      }
      if (params.configId !== "model" && params.configId !== "thought_level") {
        throw RequestError.invalidParams(
          { configId: params.configId },
          "Session configuration option is unsupported.",
        );
      }
      const configOptions = sessionConfigOptions(await runRegistry(registry.setConfig(record.sessionId, {
        configId: params.configId,
        value: params.value,
      })));
      await notify(record, { sessionUpdate: "config_option_update", configOptions });
      return { configOptions };
    })
    .onRequest(methods.agent.session.prompt, async ({ params }) => {
      const record = requireRecord(params.sessionId);
      const text = promptText(params.prompt);
      const userMessageId = makeMessageId();
      const handle = await runRegistry(registry.prompt(record.sessionId, text, async () => {
        await notify(record, {
          sessionUpdate: "user_message",
          messageId: userMessageId,
          content: params.prompt,
        });
        await notify(record, { sessionUpdate: "state_update", state: "running" });
      }));
      void handle.completion.then(
        (stopReason) => notify(record, {
          sessionUpdate: "state_update",
          state: "idle",
          stopReason,
        }),
        () => notify(record, {
          sessionUpdate: "state_update",
          state: "idle",
          stopReason: "refusal",
        }),
      ).catch(() => undefined);
      return {};
    })
    .onNotification(methods.agent.session.cancel, async ({ params }) => {
      await runRegistry(registry.cancel(params.sessionId));
    })
    .onRequest(methods.agent.session.close, async ({ params }) => {
      const record = requireRecord(params.sessionId);
      await runRegistry(registry.close(record.sessionId));
      records.delete(record.sessionId);
      log(`session closed ${record.sessionId}`);
      return {};
    });

  return Object.assign(app, { shutdown });
};
