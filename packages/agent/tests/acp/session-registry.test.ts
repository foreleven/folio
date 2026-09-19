import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  createAgentSession,
  type EditToolInput,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeSessionRegistry } from "../../src/acp/session-registry.js";
import {
  PI_ACP_PROMPT_OPTIONS,
  PiSessionFactoryError,
  makePiSessionFactory,
  type PiSessionFactory,
  type PiSessionRuntime,
} from "../../src/pi/session-factory.js";
import type { CompiledModelProfile } from "../../src/model/model-config-compiler.js";

const piEvent = (value: unknown): AgentSessionEvent => value as AgentSessionEvent;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

const compiledProfile = {
  profileId: "profile-1",
  model: {
    id: "model-1",
    name: "Model 1",
    api: "openai-completions",
    provider: "provider-1",
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 1_024,
  },
  thinkingLevel: "medium",
  credential: { source: "managed" },
} as const satisfies CompiledModelProfile;

const registryModels: readonly Model<Api>[] = [
  { ...compiledProfile.model, reasoning: true },
  { ...compiledProfile.model, id: "model-2", name: "Model 2", reasoning: false },
];

class FakePiSession {
  readonly events: string[] = [];
  readonly promptOptions: unknown[] = [];
  readonly sessionManager = { getCwd: () => this.cwd } as PiSessionRuntime["sessionManager"];
  thinkingLevel: ModelThinkingLevel = "medium";
  model: Model<Api> = registryModels[0]!;
  readonly availableModels = registryModels;
  #listener: ((event: AgentSessionEvent) => void) | undefined;
  #idle = true;
  #resolvePrompt: (() => void) | undefined;
  #rejectPrompt: ((error: Error) => void) | undefined;

  constructor(readonly cwd: string) {}

  get isIdle(): boolean {
    return this.#idle;
  }

  getActiveToolNames(): string[] {
    return [];
  }

  getAvailableThinkingLevels(): ModelThinkingLevel[] {
    return this.model.reasoning ? ["off", "low", "medium", "high"] : ["off"];
  }

  async setModel(model: Model<Api>): Promise<void> {
    this.events.push(`model:${model.id}`);
    this.model = model;
    if (!model.reasoning) this.thinkingLevel = "off";
  }

  setThinkingLevel(level: ModelThinkingLevel): void {
    this.events.push(`thinking:${level}`);
    this.thinkingLevel = this.getAvailableThinkingLevels().includes(level) ? level : "off";
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listener = listener;
    return () => {
      this.events.push("unsubscribe");
      this.#listener = undefined;
    };
  }

  emit(event: AgentSessionEvent): void {
    this.#listener?.(event);
  }

  prompt(_text: string, options?: unknown): Promise<void> {
    this.events.push("prompt");
    this.promptOptions.push(options);
    this.#idle = false;
    return new Promise<void>((resolve, reject) => {
      this.#resolvePrompt = () => {
        this.#idle = true;
        resolve();
      };
      this.#rejectPrompt = (error) => {
        this.#idle = true;
        reject(error);
      };
    });
  }

  complete(): void {
    this.#resolvePrompt?.();
  }

  fail(error: Error): void {
    this.#rejectPrompt?.(error);
  }

  async abort(): Promise<void> {
    this.events.push("abort");
    this.#rejectPrompt?.(new Error("aborted"));
  }

  async waitForIdle(): Promise<void> {
    this.events.push("waitForIdle");
    await Promise.resolve();
  }

  dispose(): void {
    this.events.push("dispose");
  }
}

const makeFakeFactory = () => {
  const sessions = new Map<string, FakePiSession>();
  const factory: PiSessionFactory = {
    create: (cwd) => Effect.sync(() => {
      const session = new FakePiSession(cwd);
      sessions.set(cwd, session);
      return session;
    }),
  };
  return { factory, sessions };
};

describe("Pi session factory", () => {
  it("uses the public factory with explicit Folio configuration and full-access tools", async () => {
    const directory = await mkdtemp(join(tmpdir(), "folio-pi-factory-storage-"));
    temporaryDirectories.push(directory);
    const session = new FakePiSession("/workspace");
    const createAgentSession = vi.fn(async (_options: CreateAgentSessionOptions) => ({
      session: session as unknown as AgentSession,
    }));
    const modelRuntime = { getAvailableSnapshot: () => registryModels } as unknown as ModelRuntime;
    const factory = makePiSessionFactory({
      agentDirectory: "/folio/agent",
      sessionDirectory: directory,
      modelRuntime,
      profile: compiledProfile,
      createAgentSession,
    });

    const result = await Effect.runPromise(factory.create("/workspace"));
    expect(result).toBe(session);
    expect(result.availableModels).toEqual(registryModels);
    expect(createAgentSession).toHaveBeenCalledOnce();
    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/workspace",
      agentDir: "/folio/agent",
      modelRuntime,
      model: compiledProfile.model,
      thinkingLevel: "medium",
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      customTools: [],
      sessionManager: expect.objectContaining({
        getCwd: expect.any(Function),
        isPersisted: expect.any(Function),
      }),
      settingsManager: expect.objectContaining({
        isProjectTrusted: expect.any(Function),
        getDefaultTools: expect.any(Function),
      }),
      resourceLoader: expect.any(Object),
    }));
    const options = createAgentSession.mock.calls[0]![0] as unknown as Record<string, unknown>;
    const sessionManager = options.sessionManager as {
      getCwd: () => string;
      isPersisted: () => boolean;
    };
    const settingsManager = options.settingsManager as {
      isProjectTrusted: () => boolean;
      getDefaultTools: () => string[] | undefined;
    };
    const resourceLoader = options.resourceLoader as {
      getExtensions: () => { extensions: unknown[] };
      getSkills: () => { skills: unknown[] };
      getPrompts: () => { prompts: unknown[] };
      getAgentsFiles: () => { agentsFiles: unknown[] };
    };
    expect(sessionManager.getCwd()).toBe("/workspace");
    expect(sessionManager.isPersisted()).toBe(true);
    expect(settingsManager.isProjectTrusted()).toBe(false);
    expect(settingsManager.getDefaultTools()).toBeUndefined();
    expect(resourceLoader.getExtensions().extensions).toEqual([]);
    expect(resourceLoader.getSkills().skills).toEqual([]);
    expect(resourceLoader.getPrompts().prompts).toEqual([]);
    expect(resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
  });

  it("constructs and disposes a real Pi AgentSession without network, with full-access tools and durable native metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "folio-pi-session-factory-"));
    temporaryDirectories.push(directory);
    const runtime = await ModelRuntime.create({
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const factory = makePiSessionFactory({
      agentDirectory: join(directory, "agent"),
      modelRuntime: runtime,
      profile: compiledProfile,
    });

    const session = await Effect.runPromise(factory.create(directory));
    expect(session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
    expect(session.sessionManager.getCwd()).toBe(directory);
    expect(session.sessionManager.isPersisted()).toBe(true);
    expect(session.thinkingLevel).toBe("off");
    await session.waitForIdle();
    session.dispose();
  });

  it("loads only explicit skills and Task AGENTS.md and executes native file and shell tools", async () => {
    const directory = await mkdtemp(join(tmpdir(), "folio-pi-tools-"));
    temporaryDirectories.push(directory);
    const cwd = join(directory, "task");
    const skill = join(directory, "selected-skill");
    await mkdir(cwd);
    await mkdir(skill);
    await mkdir(join(cwd, ".pi", "skills", "unselected"), { recursive: true });
    await writeFile(join(directory, "AGENTS.md"), "PARENT_CONTEXT_SENTINEL");
    await writeFile(join(cwd, "AGENTS.md"), "TASK_CONTEXT_SENTINEL");
    await writeFile(join(skill, "SKILL.md"), "---\nname: selected-skill\ndescription: Selected integration\n---\nRun its script.\n");
    await writeFile(join(skill, "fetch.sh"), 'pwd > script-cwd.txt\nprintf raw > raw.txt\n');
    await writeFile(join(cwd, ".pi", "skills", "unselected", "SKILL.md"),
      "---\nname: unselected\ndescription: UNSELECTED_SKILL_SENTINEL\n---\nDo not load.\n");
    const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
    let native: AgentSession | undefined;
    const factory = makePiSessionFactory({
      agentDirectory: join(directory, "agent"),
      modelRuntime: runtime,
      profile: compiledProfile,
      skillPaths: [skill],
      createAgentSession: async (options) => {
        const result = await createAgentSession(options);
        native = result.session;
        return result;
      },
    });
    const session = await Effect.runPromise(factory.create(cwd));
    try {
      expect(native!.systemPrompt).toContain("TASK_CONTEXT_SENTINEL");
      expect(native!.systemPrompt).toContain("selected-skill");
      expect(native!.systemPrompt).not.toContain("PARENT_CONTEXT_SENTINEL");
      expect(native!.systemPrompt).not.toContain("UNSELECTED_SKILL_SENTINEL");
      const tool = (name: string) => native!.agent.state.tools.find((entry) => entry.name === name)!;
      await tool("write").execute("write-1", { path: "wiki/page.md", content: "before" });
      await tool("edit").execute("edit-1", { path: "wiki/page.md", edits: [{ oldText: "before", newText: "after" }] } satisfies EditToolInput);
      expect(await readFile(join(cwd, "wiki/page.md"), "utf8")).toBe("after");
      const read = await tool("read").execute("read-1", { path: "wiki/page.md" });
      expect(read.content).toContainEqual({ type: "text", text: "after" });
      await tool("bash").execute("bash-1", { command: `bash '${join(skill, "fetch.sh")}'` });
      expect((await readFile(join(cwd, "script-cwd.txt"), "utf8")).trim()).toBe(await realpath(cwd));
      expect(await readFile(join(cwd, "raw.txt"), "utf8")).toBe("raw");
      await expect(tool("bash").execute("bash-failure", { command: "exit 7" })).rejects.toThrow();
      const controller = new AbortController();
      const running = tool("bash").execute("bash-cancel", { command: "sleep 30" }, controller.signal);
      const timer = setTimeout(() => controller.abort(), 100);
      try { await expect(running).rejects.toThrow(); } finally { clearTimeout(timer); }
    } finally {
      await session.abort();
      session.dispose();
    }
  });

  it("rejects relative Folio agent directory before invoking Pi", async () => {
    const createAgentSession = vi.fn(async (_options: CreateAgentSessionOptions) => ({
      session: new FakePiSession("/unused") as unknown as AgentSession,
    }));
    const factory = makePiSessionFactory({
      agentDirectory: "relative-agent-dir",
      modelRuntime: {} as ModelRuntime,
      profile: compiledProfile,
      createAgentSession,
    });

    await expect(Effect.runPromise(factory.create("/workspace"))).rejects.toMatchObject({
      reason: "invalid_agent_directory",
      message: "Folio agent directory must be absolute.",
    });
    expect(createAgentSession).not.toHaveBeenCalled();
  });

  it("rejects relative cwd before invoking Pi and exposes a stable failure", async () => {
    const createAgentSession = vi.fn(async (_options: CreateAgentSessionOptions) => ({
      session: new FakePiSession("/unused") as unknown as AgentSession,
    }));
    const factory = makePiSessionFactory({
      agentDirectory: "/folio/agent",
      modelRuntime: {} as ModelRuntime,
      profile: compiledProfile,
      createAgentSession,
    });

    await expect(Effect.runPromise(factory.create("relative/path"))).rejects.toMatchObject({
      reason: "invalid_cwd",
      message: "Session working directory must be absolute.",
    });
    expect(createAgentSession).not.toHaveBeenCalled();
  });
});

describe("Session Registry", () => {
  it("does not report end_turn when an emitted event could not be persisted or delivered", async () => {
    const { factory, sessions } = makeFakeFactory();
    const registry = makeSessionRegistry({ sessionFactory: factory, onEvent: () => { throw new Error("unavailable sink"); } });
    await Effect.runPromise(registry.create("archive-failure", "/workspace"));
    const handle = await Effect.runPromise(registry.prompt("archive-failure", "test"));
    const pi = sessions.get("/workspace")!;
    pi.emit(piEvent({ type: "agent_start" }));
    pi.complete();
    await expect(handle.completion).rejects.toMatchObject({ reason: "prompt_failed" });
    await Effect.runPromise(registry.shutdown);
  });

  it("isolates Pi sessions, serializes per-session events, and rejects concurrent work", async () => {
    const { factory, sessions } = makeFakeFactory();
    const updates: string[] = [];
    const registry = makeSessionRegistry({
      sessionFactory: factory,
      onEvent: async (sessionId, event) => {
        await Promise.resolve();
        updates.push(`${sessionId}:${event.type}`);
      },
    });

    await Effect.runPromise(registry.create("session-a", "/workspace/a"));
    await Effect.runPromise(registry.create("session-b", "/workspace/b"));
    const sessionA = sessions.get("/workspace/a")!;
    const sessionB = sessions.get("/workspace/b")!;
    sessionA.emit(piEvent({ type: "agent_start" }));
    sessionB.emit(piEvent({ type: "turn_start" }));

    const first = await Effect.runPromise(registry.prompt("session-a", "first"));
    await expect(Effect.runPromise(registry.prompt("session-a", "second"))).rejects.toMatchObject({
      reason: "session_busy",
    });
    const other = await Effect.runPromise(registry.prompt("session-b", "parallel"));
    expect(registry.list()).toEqual([
      { sessionId: "session-a", cwd: "/workspace/a", state: "prompting" },
      { sessionId: "session-b", cwd: "/workspace/b", state: "prompting" },
    ]);
    expect(sessionA.promptOptions).toEqual([PI_ACP_PROMPT_OPTIONS]);
    expect(sessionB.promptOptions).toEqual([PI_ACP_PROMPT_OPTIONS]);

    sessionA.complete();
    sessionB.complete();
    await Promise.all([first.completion, other.completion]);
    await Effect.runPromise(registry.close("session-a"));
    await Effect.runPromise(registry.close("session-b"));
    expect(updates).toEqual(["session-a:agent_start", "session-b:turn_start"]);
  });

  it("cancels only the targeted session and returns it to idle", async () => {
    const { factory, sessions } = makeFakeFactory();
    const registry = makeSessionRegistry({ sessionFactory: factory, onEvent: () => undefined });
    await Effect.runPromise(registry.create("session-a", "/workspace/a"));
    await Effect.runPromise(registry.create("session-b", "/workspace/b"));
    const first = await Effect.runPromise(registry.prompt("session-a", "cancel me"));
    const second = await Effect.runPromise(registry.prompt("session-b", "keep running"));

    await Effect.runPromise(registry.cancel("session-a"));
    await first.completion;
    expect(await Effect.runPromise(registry.get("session-a"))).toMatchObject({ state: "idle" });
    expect(await Effect.runPromise(registry.get("session-b"))).toMatchObject({ state: "prompting" });
    expect(sessions.get("/workspace/a")!.events).toContain("abort");
    expect(sessions.get("/workspace/b")!.events).not.toContain("abort");

    sessions.get("/workspace/b")!.complete();
    await second.completion;
    await Effect.runPromise(registry.shutdown);
  });

  it("mutates model and thinking options per session and reports actual effective values", async () => {
    const { factory, sessions } = makeFakeFactory();
    const registry = makeSessionRegistry({ sessionFactory: factory, onEvent: () => undefined });
    await Effect.runPromise(registry.create("session-a", "/workspace/a"));
    await Effect.runPromise(registry.create("session-b", "/workspace/b"));
    const initial = await Effect.runPromise(registry.config("session-a"));
    expect(initial).toMatchObject({
      thinkingLevel: "medium",
      thinkingLevels: ["off", "low", "medium", "high"],
    });
    expect(initial.models).toHaveLength(2);

    const modelTwo = initial.models.find(({ name }) => name === "Model 2")!;
    const switched = await Effect.runPromise(registry.setConfig("session-a", {
      configId: "model",
      value: modelTwo.value,
    }));
    expect(switched).toMatchObject({
      modelValue: modelTwo.value,
      thinkingLevel: "off",
      thinkingLevels: ["off"],
    });
    const thought = await Effect.runPromise(registry.setConfig("session-a", {
      configId: "thought_level",
      value: "off",
    }));
    expect(thought.thinkingLevel).toBe("off");
    expect((await Effect.runPromise(registry.config("session-b"))).modelValue).not.toBe(modelTwo.value);
    expect(sessions.get("/workspace/a")?.events).toEqual(["model:model-2", "thinking:off"]);
    expect(sessions.get("/workspace/b")?.events).toEqual([]);
    await Effect.runPromise(registry.shutdown);
  });

  it("rejects config changes while busy and normalizes unknown values and provider failures", async () => {
    const secret = "secret-provider-set-model";
    const { factory, sessions } = makeFakeFactory();
    const registry = makeSessionRegistry({ sessionFactory: factory, onEvent: () => undefined });
    await Effect.runPromise(registry.create("session-a", "/workspace/a"));
    const initial = await Effect.runPromise(registry.config("session-a"));
    await expect(Effect.runPromise(registry.setConfig("session-a", {
      configId: "model",
      value: "invalid",
    }))).rejects.toMatchObject({ reason: "config_value_unsupported" });
    await expect(Effect.runPromise(registry.setConfig("session-a", {
      configId: "thought_level",
      value: "max",
    }))).rejects.toMatchObject({ reason: "config_value_unsupported" });

    const prompt = await Effect.runPromise(registry.prompt("session-a", "busy"));
    await expect(Effect.runPromise(registry.setConfig("session-a", {
      configId: "model",
      value: initial.models[0]!.value,
    }))).rejects.toMatchObject({ reason: "session_busy" });
    sessions.get("/workspace/a")!.complete();
    await prompt.completion;

    const session = sessions.get("/workspace/a")!;
    session.setModel = async () => {
      throw new Error(secret);
    };
    await expect(Effect.runPromise(registry.setConfig("session-a", {
      configId: "model",
      value: initial.models[1]!.value,
    }))).rejects.toSatisfy((error) => {
      const visible = JSON.stringify(error);
      return visible.includes("config_update_failed") && !visible.includes(secret);
    });
    expect(await Effect.runPromise(registry.get("session-a"))).toMatchObject({ state: "idle" });
    await Effect.runPromise(registry.shutdown);
  });

  it("closes and shuts down with abort, event drain, unsubscribe, and dispose ordering", async () => {
    const { factory, sessions } = makeFakeFactory();
    let releaseEvent: (() => void) | undefined;
    const eventGate = new Promise<void>((resolve) => {
      releaseEvent = resolve;
    });
    const registry = makeSessionRegistry({
      sessionFactory: factory,
      onEvent: async () => eventGate,
    });
    await Effect.runPromise(registry.create("session-a", "/workspace/a"));
    await Effect.runPromise(registry.create("session-b", "/workspace/b"));
    const sessionA = sessions.get("/workspace/a")!;
    const sessionB = sessions.get("/workspace/b")!;
    const work = await Effect.runPromise(registry.prompt("session-a", "active"));
    sessionA.emit(piEvent({ type: "agent_start" }));

    let closed = false;
    const close = Effect.runPromise(registry.close("session-a")).then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(sessionA.events).toEqual(["prompt", "abort"]);
    releaseEvent?.();
    await Promise.all([work.completion, close]);
    expect(sessionA.events).toEqual(["prompt", "abort", "waitForIdle", "unsubscribe", "dispose"]);
    await expect(Effect.runPromise(registry.get("session-a"))).rejects.toMatchObject({
      reason: "session_not_found",
    });

    await Effect.runPromise(registry.shutdown);
    expect(sessionB.events).toEqual(["waitForIdle", "unsubscribe", "dispose"]);
    expect(registry.list()).toEqual([]);
    await expect(Effect.runPromise(registry.create("session-c", "/workspace/c"))).rejects.toMatchObject({
      reason: "session_closed",
    });
  });

  it("reserves session IDs while factory creation is in flight", async () => {
    let releaseFactory: ((session: PiSessionRuntime) => void) | undefined;
    const factoryGate = new Promise<PiSessionRuntime>((resolve) => {
      releaseFactory = resolve;
    });
    let creations = 0;
    const factory: PiSessionFactory = {
      create: () => {
        creations += 1;
        return Effect.promise(() => factoryGate);
      },
    };
    const registry = makeSessionRegistry({ sessionFactory: factory, onEvent: () => undefined });

    const first = Effect.runPromise(registry.create("same", "/workspace/a"));
    await expect(Effect.runPromise(registry.create("same", "/workspace/b"))).rejects.toMatchObject({
      reason: "session_exists",
    });
    expect(creations).toBe(1);
    releaseFactory?.(new FakePiSession("/workspace/a"));
    await first;
    await Effect.runPromise(registry.shutdown);
  });

  it("waits for an in-flight factory during shutdown and releases the unregistered session", async () => {
    let releaseFactory: ((session: PiSessionRuntime) => void) | undefined;
    const factoryGate = new Promise<PiSessionRuntime>((resolve) => {
      releaseFactory = resolve;
    });
    const session = new FakePiSession("/workspace/late");
    const factory: PiSessionFactory = {
      create: () => Effect.promise(() => factoryGate),
    };
    const registry = makeSessionRegistry({ sessionFactory: factory, onEvent: () => undefined });

    const creating = Effect.runPromise(registry.create("late", "/workspace/late"));
    let shutdownComplete = false;
    const shutdown = Effect.runPromise(registry.shutdown).then(() => {
      shutdownComplete = true;
    });
    await Promise.resolve();
    expect(shutdownComplete).toBe(false);

    releaseFactory?.(session);
    await expect(creating).rejects.toMatchObject({ reason: "session_closed" });
    await shutdown;
    expect(session.events).toEqual(["waitForIdle", "dispose"]);
    expect(registry.list()).toEqual([]);
  });

  it("normalizes factory and prompt failures without retaining raw errors", async () => {
    const rawFactoryError = "secret-provider-factory-error";
    const rawPromptError = "secret-provider-prompt-error";
    const failedFactory: PiSessionFactory = {
      create: () => Effect.fail(new PiSessionFactoryError({
        reason: "session_unavailable",
        message: rawFactoryError,
      })),
    };
    const failedRegistry = makeSessionRegistry({ sessionFactory: failedFactory, onEvent: () => undefined });
    await expect(Effect.runPromise(failedRegistry.create("failed", "/workspace"))).rejects.toMatchObject({
      reason: "session_unavailable",
      message: "Session could not be created.",
    });

    const { factory, sessions } = makeFakeFactory();
    const registry = makeSessionRegistry({ sessionFactory: factory, onEvent: () => undefined });
    await Effect.runPromise(registry.create("session-a", "/workspace/a"));
    const session = sessions.get("/workspace/a")!;
    const handle = await Effect.runPromise(registry.prompt("session-a", "fail"));
    session.fail(new Error(rawPromptError));
    await expect(handle.completion).rejects.toMatchObject({
      reason: "prompt_failed",
      message: "Session prompt failed.",
    });
    expect(JSON.stringify(await Effect.runPromise(registry.get("session-a")))).not.toContain(rawPromptError);
    await Effect.runPromise(registry.shutdown);
  });
});
