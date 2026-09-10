import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Predicate, Schema } from "effect";
import { resolveFolioAgentDirectory, resolveFolioConfigDirectory, type ResolveAgentDirectoryOptions } from "./directory.js";
import { decodeAgentSettings, type AgentSettings, type ModelProfile } from "./schema.js";

export const AgentConfigLoadFailureReason = Schema.Literals([
  "configuration_unavailable",
  "configuration_invalid",
]);
export type AgentConfigLoadFailureReason = typeof AgentConfigLoadFailureReason.Type;

/** Stable standalone configuration failure which never retains source text or an underlying cause. */
export class AgentConfigLoadError extends Schema.TaggedError<AgentConfigLoadError>()(
  "AgentConfigLoadError",
  {
    reason: AgentConfigLoadFailureReason,
    message: Schema.String,
  },
) {}

const failureMessage: Record<AgentConfigLoadFailureReason, string> = {
  configuration_unavailable: "Agent configuration is unavailable.",
  configuration_invalid: "Agent configuration is invalid.",
};

const failure = (reason: AgentConfigLoadFailureReason): AgentConfigLoadError =>
  new AgentConfigLoadError({ reason, message: failureMessage[reason] });

export interface FolioAgentConfigSnapshot {
  readonly configDirectory: string;
  readonly agentDirectory: string;
  readonly settings: AgentSettings;
  readonly defaultProfile?: ModelProfile;
}

export interface LoadFolioAgentConfigOptions extends ResolveAgentDirectoryOptions {
  /** Test seam for deterministic filesystem failures; production reads the resolved config.json. */
  readonly readConfigFile?: (path: string) => Promise<string>;
}

/**
 * Reads the Folio-owned config snapshot for standalone processes.
 * Missing config uses safe disabled defaults; malformed JSON or AgentSettings fails closed.
 */
export const loadFolioAgentConfig = Effect.fn("AgentConfigLoader.loadFolioAgentConfig")(
  function*(options: LoadFolioAgentConfigOptions = {}) {
    const configDirectory = resolveFolioConfigDirectory(options);
    const agentDirectory = resolveFolioAgentDirectory(options);
    const filePath = join(configDirectory, "config.json");
    const read = options.readConfigFile ?? ((path: string) => readFile(path, "utf8"));
    const source = yield* Effect.tryPromise({
      try: async () => {
        try {
          return await read(filePath);
        } catch (error) {
          if (Predicate.hasProperty(error, "code") && error.code === "ENOENT") return "{}";
          throw error;
        }
      },
      catch: () => failure("configuration_unavailable"),
    });
    const root = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(source).pipe(
      Effect.mapError(() => failure("configuration_invalid")),
    );
    if (!Predicate.isObject(root)) return yield* failure("configuration_invalid");
    const settings = yield* decodeAgentSettings(
      Predicate.hasProperty(root, "agent") ? root.agent : {},
    ).pipe(Effect.mapError(() => failure("configuration_invalid")));
    const defaultProfile = settings.defaultModelProfileId === undefined
      ? undefined
      : settings.modelProfiles.find(({ id }) => id === settings.defaultModelProfileId);
    return {
      configDirectory,
      agentDirectory,
      settings,
      ...(defaultProfile === undefined ? {} : { defaultProfile }),
    } satisfies FolioAgentConfigSnapshot;
  },
);
