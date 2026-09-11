import { ThinkingLevel } from "../config/schema.js";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  DefaultResourceLoader,
  SettingsManager,
  createAgentSession,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type PromptOptions,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Effect, Schema } from "effect";
import type { CompiledModelProfile } from "../model/model-config-compiler.js";
import { openPiSessionStorage, type PiSessionIdentity } from "./session-storage.js";

export type PiSessionRuntime = Pick<
  AgentSession,
  | "abort"
  | "dispose"
  | "getActiveToolNames"
  | "getAvailableThinkingLevels"
  | "isIdle"
  | "model"
  | "prompt"
  | "sessionManager"
  | "setModel"
  | "setThinkingLevel"
  | "subscribe"
  | "thinkingLevel"
  | "waitForIdle"
> & {
  /** Credential-blind models approved for this Folio process snapshot. */
  readonly availableModels: readonly Model<Api>[];
};

export interface PiSessionFactory {
  readonly create: (cwd: string, resume?: PiSessionIdentity) => Effect.Effect<PiSessionRuntime, PiSessionFactoryError>;
}

export const PiSessionFactoryFailureReason = Schema.Literals([
  "invalid_agent_directory",
  "invalid_cwd",
  "session_unavailable",
]);
export type PiSessionFactoryFailureReason = typeof PiSessionFactoryFailureReason.Type;

/** Stable factory failure which deliberately excludes Pi/provider errors and source values. */
export class PiSessionFactoryError extends Schema.TaggedError<PiSessionFactoryError>()(
  "PiSessionFactoryError",
  {
    reason: PiSessionFactoryFailureReason,
    message: Schema.String,
  },
) {}

const failureMessage: Record<PiSessionFactoryFailureReason, string> = {
  invalid_agent_directory: "Folio agent directory must be absolute.",
  invalid_cwd: "Session working directory must be absolute.",
  session_unavailable: "Pi session could not be created.",
};

const failure = (reason: PiSessionFactoryFailureReason): PiSessionFactoryError =>
  new PiSessionFactoryError({ reason, message: failureMessage[reason] });

type CreateAgentSession = (options: CreateAgentSessionOptions) => Promise<{
  readonly session: AgentSession;
}>;

export interface PiSessionProfile {
  readonly profileId: CompiledModelProfile["profileId"];
  readonly model: CompiledModelProfile["model"];
  readonly thinkingLevel: CompiledModelProfile["thinkingLevel"];
}

export interface PiSessionFactoryOptions {
  /** Explicit skill files/directories assembled by the harness; global discovery remains disabled. */
  readonly skillPaths?: readonly string[];
  /** Folio-owned native session directory; the harness can locate it under a Vault, outside Git. */
  readonly sessionDirectory?: string;
  /** Folio-owned runtime directory. Never defaults to ~/.pi/agent. */
  readonly agentDirectory: string;
  /** Shared, already configured model/auth runtime used by every created session. */
  readonly modelRuntime: ModelRuntime;
  /** Immutable, credential-free model profile snapshot captured when the ACP session is created. */
  readonly profile: PiSessionProfile;
  /** Test seam around Pi's public createAgentSession factory. */
  readonly createAgentSession?: CreateAgentSession;
}

/**
 * Creates full-access Pi sessions with Folio-owned configuration and explicit resources.
 * Only the Task root AGENTS.md is context; parent/global Pi configuration is not inherited.
 * These resource choices are configuration isolation, not a filesystem security boundary.
 */
export const makePiSessionFactory = (options: PiSessionFactoryOptions): PiSessionFactory => {
  const createSession = options.createAgentSession ?? createAgentSession;

  const create = Effect.fn("PiSessionFactory.create")(function*(cwd: string, resume?: PiSessionIdentity) {
    if (!isAbsolute(options.agentDirectory)) return yield* failure("invalid_agent_directory");
    if (!isAbsolute(cwd)) return yield* failure("invalid_cwd");

    const sessionManager = yield* openPiSessionStorage({
      cwd, directory: options.sessionDirectory ?? join(options.agentDirectory, "sessions"), resume,
    }).pipe(Effect.mapError(() => failure("session_unavailable")));

    return yield* Effect.tryPromise({
      try: async () => {
        const settingsManager = SettingsManager.inMemory(
          {},
          { projectTrusted: false },
        );
        const agentsPath = join(cwd, "AGENTS.md");
        const agentsContent = await readFile(agentsPath, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        const resourceLoader = new DefaultResourceLoader({
          cwd,
          agentDir: options.agentDirectory,
          settingsManager,
          noExtensions: true,
          noSkills: true,
          additionalSkillPaths: [...(options.skillPaths ?? [])],
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          // Empty explicit sources preserve Pi defaults without discovering SYSTEM.md files.
          systemPrompt: "",
          appendSystemPrompt: [],
          agentsFilesOverride: () => ({
            agentsFiles: agentsContent === undefined ? [] : [{ path: agentsPath, content: agentsContent }],
          }),
        });
        await resourceLoader.reload();

        // Pi restores model/thinking only when messages exist. An initialized, unused Session
        // still owns these choices; never let the SDK silently choose another provider default.
        const previous = resume === undefined ? undefined : sessionManager.buildSessionContext();
        const selectedModel = previous?.model
          ? options.modelRuntime.getModel(previous.model.provider, previous.model.modelId)
          : options.profile.model;
        if (selectedModel === undefined) throw new Error("saved model unavailable");
        const selectedThinking = resume !== undefined && sessionManager.getBranch().some(entry => entry.type === "thinking_level_change")
          ? Schema.decodeUnknownSync(ThinkingLevel)(previous!.thinkingLevel) : options.profile.thinkingLevel;
        const result = await createSession({
          cwd,
          agentDir: options.agentDirectory,
          modelRuntime: options.modelRuntime,
          model: selectedModel,
          thinkingLevel: selectedThinking,
          tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
          customTools: [],
          resourceLoader,
          sessionManager,
          settingsManager,
        });
        const session = result.session as AgentSession;
        const availableModels = options.modelRuntime.getAvailableSnapshot();
        const includesCurrent = availableModels.some(
          (model) => model.provider === options.profile.model.provider && model.id === options.profile.model.id,
        );
        Object.defineProperty(session, "availableModels", {
          configurable: false,
          enumerable: false,
          writable: false,
          value: Object.freeze(includesCurrent
            ? [...availableModels]
            : [options.profile.model, ...availableModels]),
        });
        return session as unknown as PiSessionRuntime;
      },
      catch: () => failure("session_unavailable"),
    });
  });

  return { create };
};

/** Public prompt options used by the Registry without exposing Pi's full SDK surface. */
export const PI_ACP_PROMPT_OPTIONS = {
  expandPromptTemplates: false,
  source: "rpc",
} as const satisfies PromptOptions;

export type PiSessionEventListener = (event: AgentSessionEvent) => void;
