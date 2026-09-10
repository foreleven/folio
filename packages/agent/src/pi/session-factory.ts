import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type PromptOptions,
} from "@earendil-works/pi-coding-agent";
import { isAbsolute } from "node:path";
import { Effect, Schema } from "effect";
import type { CompiledModelProfile } from "../model/model-config-compiler.js";

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
  readonly create: (cwd: string) => Effect.Effect<PiSessionRuntime, PiSessionFactoryError>;
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
 * Creates isolated Pi AgentSessions without loading Pi global/project configuration.
 * M3 is text-only: all tools, extensions, skills, prompt templates and project context are disabled
 * until WorkspacePolicy and permission enforcement land in M4.
 */
export const makePiSessionFactory = (options: PiSessionFactoryOptions): PiSessionFactory => {
  const createSession = options.createAgentSession ?? createAgentSession;

  const create = Effect.fn("PiSessionFactory.create")(function*(cwd: string) {
    if (!isAbsolute(options.agentDirectory)) return yield* failure("invalid_agent_directory");
    if (!isAbsolute(cwd)) return yield* failure("invalid_cwd");

    return yield* Effect.tryPromise({
      try: async () => {
        const settingsManager = SettingsManager.inMemory(
          { defaultTools: [] },
          { projectTrusted: false },
        );
        const resourceLoader = new DefaultResourceLoader({
          cwd,
          agentDir: options.agentDirectory,
          settingsManager,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        });
        await resourceLoader.reload();

        const result = await createSession({
          cwd,
          agentDir: options.agentDirectory,
          modelRuntime: options.modelRuntime,
          model: options.profile.model,
          thinkingLevel: options.profile.thinkingLevel,
          noTools: "all",
          tools: [],
          customTools: [],
          resourceLoader,
          sessionManager: SessionManager.inMemory(cwd),
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
