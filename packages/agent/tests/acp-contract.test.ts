import {
  PROTOCOL_VERSION,
  batchRequest,
  client,
  methods,
  type ClientContext,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createFolioAgentApp } from "../src/acp/server.js";
import { PiSessionFactoryError, type PiSessionFactory, type PiSessionRuntime } from "../src/pi/session-factory.js";
import type { FakeModel } from "../src/pi/fake-model.js";

const initialize = (context: ClientContext) =>
  context.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    info: { name: "folio-agent-contract", version: "0.1.0" },
    capabilities: {},
  });

const piEvent = (value: unknown): AgentSessionEvent => value as AgentSessionEvent;

const contractModels: readonly Model<Api>[] = [
  {
    id: "contract",
    name: "Contract",
    api: "openai-completions",
    provider: "contract",
    baseUrl: "https://example.invalid/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 1_024,
  },
  {
    id: "contract-alt",
    name: "Contract Alt",
    api: "openai-completions",
    provider: "contract",
    baseUrl: "https://example.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 1_024,
  },
];

class ContractPiSession implements PiSessionRuntime {
  readonly sessionManager;
  thinkingLevel: ModelThinkingLevel = "off";
  model: Model<Api> = contractModels[0]!;
  readonly availableModels = contractModels;
  disposed = false;
  aborted = false;
  #listener: ((event: AgentSessionEvent) => void) | undefined;
  #idle = true;
  #resolve: (() => void) | undefined;
  #reject: ((error: Error) => void) | undefined;

  constructor(readonly cwd: string) {
    this.sessionManager = { getCwd: () => cwd } as PiSessionRuntime["sessionManager"];
  }

  get isIdle(): boolean {
    return this.#idle;
  }

  getActiveToolNames(): string[] {
    return [];
  }

  getAvailableThinkingLevels(): ModelThinkingLevel[] {
    return this.model.reasoning ? ["off", "low", "high"] : ["off"];
  }

  async setModel(model: Model<Api>): Promise<void> {
    this.model = model;
    if (!model.reasoning) this.thinkingLevel = "off";
  }

  setThinkingLevel(level: ModelThinkingLevel): void {
    this.thinkingLevel = this.getAvailableThinkingLevels().includes(level) ? level : "off";
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listener = listener;
    return () => {
      this.#listener = undefined;
    };
  }

  emit(event: AgentSessionEvent): void {
    this.#listener?.(event);
  }

  prompt(): Promise<void> {
    this.#idle = false;
    return new Promise<void>((resolve, reject) => {
      this.#resolve = () => {
        this.#idle = true;
        resolve();
      };
      this.#reject = (error) => {
        this.#idle = true;
        reject(error);
      };
    });
  }

  complete(): void {
    this.#resolve?.();
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.#reject?.(new Error("aborted"));
  }

  async waitForIdle(): Promise<void> {
    await Promise.resolve();
  }

  dispose(): void {
    this.disposed = true;
    this.#listener = undefined;
  }
}

const makeContractFactory = () => {
  const sessions = new Map<string, ContractPiSession>();
  const factory: PiSessionFactory = {
    create: (cwd) => Effect.sync(() => {
      const session = new ContractPiSession(cwd);
      sessions.set(cwd, session);
      return session;
    }),
  };
  return { factory, sessions };
};

const assistantMessage = {
  role: "assistant",
  content: [],
  api: "openai-completions",
  provider: "contract",
  model: "contract",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 0,
} as const;

describe("ACP v2 baseline contract", () => {
  it("acknowledges a prompt before completion and reports stable message ids and idle end_turn", async () => {
    let resolveCompletion: (value: string) => void = () => undefined;
    const completion = new Promise<string>((resolve) => {
      resolveCompletion = resolve;
    });
    const model: FakeModel = { complete: () => completion };
    const app = createFolioAgentApp({ model, sessionId: () => "session-1", log: () => undefined });

    await client().connectWith(app, async (context) => {
      const init = await initialize(context);
      expect(init).toMatchObject({
        protocolVersion: 2,
        capabilities: { session: {} },
        info: { name: "folio-agent" },
      });

      const session = await context.buildSession("/workspace").start();
      const accepted = await session.prompt("hello");
      expect(accepted).toEqual({});

      const user = await session.nextUpdate();
      const running = await session.nextUpdate();
      expect(user).toMatchObject({
        kind: "session_update",
        update: { sessionUpdate: "user_message", messageId: expect.any(String) },
      });
      expect(running).toMatchObject({
        kind: "session_update",
        update: { sessionUpdate: "state_update", state: "running" },
      });

      resolveCompletion("world");
      const message = await session.nextUpdate();
      const stop = await session.nextUpdate();
      expect(message).toMatchObject({
        kind: "session_update",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: expect.any(String),
          content: { type: "text", text: "world" },
        },
      });
      expect(stop).toMatchObject({ kind: "stop", stopReason: "end_turn" });
      session.dispose();
    });
  });

  it("supports typed JSON-RPC batches after initialization", async () => {
    let nextId = 0;
    const app = createFolioAgentApp({
      sessionId: () => `batch-${++nextId}`,
      log: () => undefined,
    });

    await client().connectWith(app, async (context) => {
      await initialize(context);
      const [first, second] = await context.batch([
        batchRequest(methods.agent.session.new, { cwd: "/workspace/one" }),
        batchRequest(methods.agent.session.new, { cwd: "/workspace/two" }),
      ]);
      expect(first).toMatchObject({ sessionId: "batch-1", configOptions: expect.any(Array) });
      expect(second).toMatchObject({ sessionId: "batch-2", configOptions: expect.any(Array) });
    });
  });

  it("supports list, full replay resume, close, and unknown-session failure", async () => {
    const replayed: SessionUpdate[] = [];
    const app = createFolioAgentApp({ sessionId: () => "session-2", log: () => undefined });
    const contractClient = client().onNotification(methods.client.session.update, ({ params }) => {
      replayed.push(params.update);
    });

    await contractClient.connectWith(app, async (context) => {
      await initialize(context);
      const created = await context.request(methods.agent.session.new, { cwd: "/workspace" });
      await context.request(methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "remember me" }],
      });

      while (!replayed.some((update) => update.sessionUpdate === "state_update" && update.state === "idle")) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      const historyLength = replayed.length;

      const listed = await context.request(methods.agent.session.list, { cwd: "/workspace" });
      expect(listed.sessions).toEqual([
        expect.objectContaining({ sessionId: created.sessionId, cwd: "/workspace" }),
      ]);

      await context.request(methods.agent.session.resume, {
        sessionId: created.sessionId,
        cwd: "/workspace",
        replayFrom: { type: "start" },
      });
      expect(replayed.slice(historyLength)).toEqual(replayed.slice(0, historyLength));

      await context.request(methods.agent.session.close, { sessionId: created.sessionId });
      await expect(
        context.request(methods.agent.session.resume, {
          sessionId: created.sessionId,
          cwd: "/workspace",
        }),
      ).rejects.toThrow();
    });
  });

  it("routes cancel to the model and finishes with idle cancelled", async () => {
    const model: FakeModel = {
      complete: ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    };
    const app = createFolioAgentApp({ model, sessionId: () => "session-3", log: () => undefined });

    await client().connectWith(app, async (context) => {
      await initialize(context);
      const session = await context.buildSession("/workspace").start();
      await session.prompt("cancel me");
      await session.nextUpdate();
      await session.nextUpdate();
      await context.notify(methods.agent.session.cancel, { sessionId: session.sessionId });
      await expect(session.nextUpdate()).resolves.toMatchObject({
        kind: "stop",
        stopReason: "cancelled",
      });
      session.dispose();
    });
  });

  it("streams two Pi sessions concurrently without crossing messages or idle ahead of output", async () => {
    const { factory, sessions } = makeContractFactory();
    let nextSession = 0;
    let nextMessage = 0;
    const app = createFolioAgentApp({
      sessionFactory: factory,
      sessionId: () => `session-${++nextSession}`,
      messageId: () => `message-${++nextMessage}`,
      log: () => undefined,
    });

    await client().connectWith(app, async (context) => {
      await initialize(context);
      const first = await context.buildSession("/workspace/one").start();
      const second = await context.buildSession("/workspace/two").start();
      await Promise.all([first.prompt("first"), second.prompt("second")]);
      expect((await first.nextUpdate()).update).toMatchObject({ sessionUpdate: "user_message", messageId: "message-1" });
      expect((await first.nextUpdate()).update).toMatchObject({ sessionUpdate: "state_update", state: "running" });
      expect((await second.nextUpdate()).update).toMatchObject({ sessionUpdate: "user_message", messageId: "message-2" });
      expect((await second.nextUpdate()).update).toMatchObject({ sessionUpdate: "state_update", state: "running" });

      const firstPi = sessions.get("/workspace/one")!;
      const secondPi = sessions.get("/workspace/two")!;
      firstPi.emit(piEvent({ type: "message_start", message: assistantMessage }));
      firstPi.emit(piEvent({
        type: "message_update",
        message: assistantMessage,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "one",
          partial: assistantMessage,
        },
      }));
      secondPi.emit(piEvent({ type: "message_start", message: assistantMessage }));
      secondPi.emit(piEvent({
        type: "message_update",
        message: assistantMessage,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "two",
          partial: assistantMessage,
        },
      }));
      firstPi.complete();
      secondPi.complete();

      const firstOutput = await first.nextUpdate();
      const secondOutput = await second.nextUpdate();
      expect(firstOutput.update).toMatchObject({
        sessionUpdate: "agent_message_chunk",
        messageId: "message-3",
        content: { text: "one" },
      });
      expect(secondOutput.update).toMatchObject({
        sessionUpdate: "agent_message_chunk",
        messageId: "message-4",
        content: { text: "two" },
      });
      await expect(first.nextUpdate()).resolves.toMatchObject({ kind: "stop", stopReason: "end_turn" });
      await expect(second.nextUpdate()).resolves.toMatchObject({ kind: "stop", stopReason: "end_turn" });
      first.dispose();
      second.dispose();
    });
  });

  it("exposes stable model/thinking options and updates one session without mutating another", async () => {
    const updates: SessionUpdate[] = [];
    const { factory, sessions } = makeContractFactory();
    let nextSession = 0;
    const app = createFolioAgentApp({
      sessionFactory: factory,
      sessionId: () => `config-${++nextSession}`,
      log: () => undefined,
    });
    const contractClient = client().onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params.update);
    });

    await contractClient.connectWith(app, async (context) => {
      await initialize(context);
      const first = await context.request(methods.agent.session.new, { cwd: "/workspace/config-one" });
      const second = await context.request(methods.agent.session.new, { cwd: "/workspace/config-two" });
      const modelOption = first.configOptions?.find(({ configId }) => configId === "model");
      const thinkingOption = first.configOptions?.find(({ configId }) => configId === "thought_level");
      expect(modelOption).toMatchObject({
        type: "select",
        category: "model",
        currentValue: expect.any(String),
        options: [
          expect.objectContaining({ name: "Contract" }),
          expect.objectContaining({ name: "Contract Alt" }),
        ],
      });
      expect(thinkingOption).toMatchObject({
        type: "select",
        category: "thought_level",
        currentValue: "off",
      });

      const thinking = await context.request(methods.agent.session.setConfigOption, {
        sessionId: first.sessionId,
        configId: "thought_level",
        type: "id",
        value: "high",
      });
      expect(thinking.configOptions.find(({ configId }) => configId === "thought_level")).toMatchObject({
        currentValue: "high",
      });
      expect(sessions.get("/workspace/config-one")?.thinkingLevel).toBe("high");

      const modelChoices = modelOption?.type === "select" && Array.isArray(modelOption.options)
        ? modelOption.options as Array<{ readonly value: string; readonly name: string }>
        : [];
      const altValue = modelChoices.find((option) => option.name === "Contract Alt");
      if (altValue === undefined) throw new Error("missing alternate model");
      const switched = await context.request(methods.agent.session.setConfigOption, {
        sessionId: first.sessionId,
        configId: "model",
        type: "id",
        value: altValue.value,
      });
      expect(switched.configOptions.find(({ configId }) => configId === "model")).toMatchObject({
        currentValue: altValue.value,
      });
      expect(switched.configOptions.find(({ configId }) => configId === "thought_level")).toMatchObject({
        currentValue: "off",
        options: [{ value: "off", name: "off" }],
      });
      expect(updates.at(-1)).toMatchObject({
        sessionUpdate: "config_option_update",
        configOptions: switched.configOptions,
      });
      expect(sessions.get("/workspace/config-one")?.model.id).toBe("contract-alt");
      expect(sessions.get("/workspace/config-two")?.model.id).toBe("contract");

      const resumed = await context.request(methods.agent.session.resume, {
        sessionId: first.sessionId,
        cwd: "/workspace/config-one",
      });
      expect(resumed.configOptions).toEqual(switched.configOptions);
      expect(second.configOptions?.find(({ configId }) => configId === "model")).toMatchObject({
        currentValue: expect.not.stringContaining("contract-alt"),
      });
    });
  });

  it("rejects busy, unknown, and malformed config mutations with stable errors", async () => {
    const { factory } = makeContractFactory();
    const app = createFolioAgentApp({
      sessionFactory: factory,
      sessionId: () => "config-errors",
      log: () => undefined,
    });

    await client().connectWith(app, async (context) => {
      await initialize(context);
      const created = await context.request(methods.agent.session.new, { cwd: "/workspace/config-errors" });
      await expect(context.request(methods.agent.session.setConfigOption, {
        sessionId: created.sessionId,
        configId: "model",
        type: "id",
        value: "unknown-model",
      })).rejects.toThrow("Session configuration value is unsupported.");
      await expect(context.request(methods.agent.session.setConfigOption, {
        sessionId: created.sessionId,
        configId: "unknown",
        type: "id",
        value: "anything",
      })).rejects.toThrow("Session configuration option is unsupported.");
      await expect(context.request(methods.agent.session.setConfigOption, {
        sessionId: created.sessionId,
        configId: "model",
        type: "boolean",
        value: true,
      })).rejects.toThrow("Session configuration values must use IDs.");

      await context.request(methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "busy" }],
      });
      await expect(context.request(methods.agent.session.setConfigOption, {
        sessionId: created.sessionId,
        configId: "thought_level",
        type: "id",
        value: "low",
      })).rejects.toThrow("Session already has foreground work.");
    });
  });

  it("normalizes provider model-switch failures without leaking their cause", async () => {
    const secret = "secret-provider-model-switch";
    const { factory, sessions } = makeContractFactory();
    const app = createFolioAgentApp({
      sessionFactory: factory,
      sessionId: () => "config-provider-failure",
      log: () => undefined,
    });

    await client().connectWith(app, async (context) => {
      await initialize(context);
      const created = await context.request(methods.agent.session.new, { cwd: "/workspace/config-provider-failure" });
      const option = created.configOptions?.find(({ configId }) => configId === "model");
      const modelChoices = option?.type === "select" && Array.isArray(option.options)
        ? option.options as Array<{ readonly value: string; readonly name: string }>
        : [];
      const alt = modelChoices.find((entry) => entry.name === "Contract Alt");
      if (alt === undefined) throw new Error("missing alternate model");
      sessions.get("/workspace/config-provider-failure")!.setModel = async () => {
        throw new Error(secret);
      };
      await expect(context.request(methods.agent.session.setConfigOption, {
        sessionId: created.sessionId,
        configId: "model",
        type: "id",
        value: alt.value,
      })).rejects.toSatisfy((error) => {
        const requestError = error as Error & { readonly data?: unknown };
        const visible = `${requestError.message} ${JSON.stringify(requestError.data)}`;
        return visible.includes("Session configuration could not be updated.") && !visible.includes(secret);
      });
    });
  });

  it("shuts down active Pi sessions through the app-level lifecycle boundary", async () => {
    const { factory, sessions } = makeContractFactory();
    const app = createFolioAgentApp({
      sessionFactory: factory,
      sessionId: () => "shutdown-session",
      log: () => undefined,
    });
    const contractClient = client();
    const connection = contractClient.connect(app);
    const context = connection.agent;
    await initialize(context);
    const session = await context.buildSession("/workspace/shutdown").start();
    await session.prompt("still running");
    await session.nextUpdate();
    await session.nextUpdate();

    await app.shutdown();
    const piSession = sessions.get("/workspace/shutdown")!;
    expect(piSession.aborted).toBe(true);
    expect(piSession.disposed).toBe(true);
    await app.shutdown();
    connection.close();
    session.dispose();
  });

  it("fails closed for unsupported roots, MCP, and session factory errors without exposing causes", async () => {
    const secret = "provider-secret-failure";
    const factory: PiSessionFactory = {
      create: () => Effect.fail(new PiSessionFactoryError({
        reason: "session_unavailable",
        message: secret,
      })),
    };
    const app = createFolioAgentApp({ sessionFactory: factory, sessionId: () => "failed", log: () => undefined });

    await client().connectWith(app, async (context) => {
      await initialize(context);
      await expect(context.request(methods.agent.session.new, {
        cwd: "/workspace",
        additionalDirectories: ["/outside"],
      })).rejects.toThrow("Additional directories are unavailable");
      await expect(context.request(methods.agent.session.new, {
        cwd: "/workspace",
        mcpServers: [{ type: "stdio", name: "blocked", command: "blocked", args: [] }],
      })).rejects.toThrow("MCP servers are unavailable");
      await expect(context.request(methods.agent.session.new, { cwd: "/workspace" })).rejects.toSatisfy((error) => {
        const requestError = error as Error & { readonly data?: unknown };
        const visible = `${requestError.message} ${JSON.stringify(requestError.data)}`;
        return visible.includes("Session could not be created.") && !visible.includes(secret);
      });
    });
  });
});
