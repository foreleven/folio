import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type { PiSessionFactory, PiSessionRuntime } from "./session-factory.js";
import { makeFakeModel, type FakeModel } from "./fake-model.js";

class FakePiSession implements PiSessionRuntime {
  readonly sessionManager;
  thinkingLevel: ModelThinkingLevel = "off";
  model: Model<Api>;
  readonly availableModels: readonly Model<Api>[];
  #listeners = new Set<(event: AgentSessionEvent) => void>();
  #idle = true;
  #controller: AbortController | undefined;
  #work: Promise<void> | undefined;

  constructor(
    cwd: string,
    private readonly fakeModel: FakeModel,
  ) {
    this.sessionManager = { getCwd: () => cwd } as PiSessionRuntime["sessionManager"];
    this.model = {
      id: "folio-fake",
      name: "Folio Fake",
      api: "openai-completions",
      provider: "folio-fake",
      baseUrl: "https://example.invalid/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_192,
      maxTokens: 1_024,
    };
    this.availableModels = [this.model];
  }

  getAvailableThinkingLevels(): ModelThinkingLevel[] {
    return ["off"];
  }

  async setModel(model: Model<Api>): Promise<void> {
    this.model = model;
  }

  setThinkingLevel(level: ModelThinkingLevel): void {
    this.thinkingLevel = level;
  }

  get isIdle(): boolean {
    return this.#idle;
  }

  getActiveToolNames(): string[] {
    return [];
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  prompt(text: string): Promise<void> {
    const controller = new AbortController();
    this.#controller = controller;
    this.#idle = false;
    const work = this.fakeModel.complete({ prompt: text, signal: controller.signal })
      .then((answer) => {
        const message = {
          role: "assistant",
          content: [],
          api: "openai-completions",
          provider: "folio-fake",
          model: "folio-fake",
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
        this.#emit({ type: "message_start", message } as unknown as AgentSessionEvent);
        this.#emit({
          type: "message_update",
          message,
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: answer,
            partial: message,
          },
        } as unknown as AgentSessionEvent);
        this.#emit({ type: "message_end", message } as unknown as AgentSessionEvent);
      })
      .finally(() => {
        if (this.#controller === controller) this.#controller = undefined;
        if (this.#work === work) this.#work = undefined;
        this.#idle = true;
      });
    this.#work = work;
    return work;
  }

  async abort(): Promise<void> {
    this.#controller?.abort(new Error("cancelled"));
    await this.#work?.catch(() => undefined);
  }

  async waitForIdle(): Promise<void> {
    await this.#work?.catch(() => undefined);
  }

  dispose(): void {
    this.#listeners.clear();
  }

  #emit(event: AgentSessionEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

export interface FakePiSessionFactoryOptions {
  readonly model?: FakeModel;
}

/** Temporary no-network adapter used by contract tests until CLI runtime composition provides real Pi. */
export const makeFakePiSessionFactory = (options: FakePiSessionFactoryOptions = {}): PiSessionFactory => {
  const model = options.model ?? makeFakeModel();
  return {
    create: (cwd) => Effect.succeed(new FakePiSession(cwd, model)),
  };
};
