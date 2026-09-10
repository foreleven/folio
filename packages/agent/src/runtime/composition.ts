import type { CreateModelRuntimeOptions, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ModelRuntime as PiModelRuntime } from "@earendil-works/pi-coding-agent";
import { chmod, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Effect, Redacted, Schema } from "effect";
import type { FolioAgentConfigSnapshot } from "../config/loader.js";
import { makePiSessionFactory, PiSessionFactoryError, type PiSessionFactory } from "../pi/session-factory.js";
import { SecureCredentialStore } from "../model/credential-store.js";
import {
  compileDefaultModelProfile,
  compileDerivedPiModelConfig,
  ModelConfigCompilerError,
  serializeDerivedPiModelConfig,
} from "../model/model-config-compiler.js";

const AGENT_DIRECTORY_MODE = 0o700;
const GENERATED_MODEL_MODE = 0o600;

export const AgentRuntimeCompositionFailureReason = Schema.Literals([
  "configuration_invalid",
  "credential_missing",
  "credential_unavailable",
  "runtime_unavailable",
]);
export type AgentRuntimeCompositionFailureReason = typeof AgentRuntimeCompositionFailureReason.Type;

/** Stable composition failure which never retains config source, credentials, provider errors, or causes. */
export class AgentRuntimeCompositionError extends Schema.TaggedError<AgentRuntimeCompositionError>()(
  "AgentRuntimeCompositionError",
  {
    reason: AgentRuntimeCompositionFailureReason,
    message: Schema.String,
  },
) {}

const failureMessage: Record<AgentRuntimeCompositionFailureReason, string> = {
  configuration_invalid: "Agent runtime configuration is invalid.",
  credential_missing: "Credential is not configured.",
  credential_unavailable: "Credential storage is unavailable.",
  runtime_unavailable: "Model runtime is unavailable.",
};

const failure = (reason: AgentRuntimeCompositionFailureReason): AgentRuntimeCompositionError =>
  new AgentRuntimeCompositionError({ reason, message: failureMessage[reason] });

const compilerFailure = (error: ModelConfigCompilerError): AgentRuntimeCompositionError => {
  if (error.reason === "credential_missing") return failure("credential_missing");
  if (error.reason === "credential_store_unavailable") return failure("credential_unavailable");
  return failure("configuration_invalid");
};

type RuntimeFactory = (options: CreateModelRuntimeOptions) => Promise<ModelRuntime>;
type SessionFactoryBuilder = typeof makePiSessionFactory;

export interface FolioAgentRuntimeCompositionOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Test seam around Pi's public ModelRuntime.create. */
  readonly runtimeFactory?: RuntimeFactory;
  /** Test seam around the already-audited safe Pi Session factory. */
  readonly sessionFactoryBuilder?: SessionFactoryBuilder;
}

export interface InitializedFolioAgentRuntime {
  readonly modelRuntime: ModelRuntime;
  readonly sessionFactory: PiSessionFactory;
  readonly profileId: string;
  readonly providerId: string;
  readonly modelId: string;
}

export interface FolioAgentRuntimeComposition {
  /** Lazily initializes the immutable runtime snapshot used by all sessions in this process. */
  readonly initialize: Effect.Effect<InitializedFolioAgentRuntime, AgentRuntimeCompositionError>;
  /** Registry-facing factory. Composition failures are intentionally reduced to a stable session error. */
  readonly sessionFactory: PiSessionFactory;
  /** Removes any non-persistent environment credential overlay. Safe to call repeatedly. */
  readonly shutdown: () => Promise<void>;
}

const writeDerivedModelConfig = (
  agentDirectory: string,
  content: string,
): Effect.Effect<string, AgentRuntimeCompositionError> => Effect.tryPromise({
  try: async () => {
    await mkdir(agentDirectory, { recursive: true, mode: AGENT_DIRECTORY_MODE });
    const directoryInfo = await lstat(agentDirectory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw new Error("invalid agent directory");
    }
    await chmod(agentDirectory, AGENT_DIRECTORY_MODE);
    const modelsPath = join(agentDirectory, "models.generated.json");
    const temporary = join(agentDirectory, `.models.generated.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, {
        encoding: "utf8",
        mode: GENERATED_MODEL_MODE,
        flag: "wx",
      });
      await chmod(temporary, GENERATED_MODEL_MODE);
      await rename(temporary, modelsPath);
      await chmod(modelsPath, GENERATED_MODEL_MODE);
      return modelsPath;
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  },
  catch: () => failure("configuration_invalid"),
});

/**
 * Composes Folio's standalone config, secure credential store, generated Pi model config, shared
 * ModelRuntime and isolated text-only Pi Session factory. The snapshot is immutable for the process:
 * existing sessions keep it, while a restarted process observes later config changes.
 */
export const makeFolioAgentRuntimeComposition = (
  snapshot: FolioAgentConfigSnapshot,
  options: FolioAgentRuntimeCompositionOptions = {},
): FolioAgentRuntimeComposition => {
  const credentials = new SecureCredentialStore({ authPath: join(snapshot.agentDirectory, "auth.json") });
  const runtimeFactory = options.runtimeFactory ?? ((input) => PiModelRuntime.create(input));
  const sessionFactoryBuilder = options.sessionFactoryBuilder ?? makePiSessionFactory;
  let initialized: Promise<InitializedFolioAgentRuntime> | undefined;
  let environmentProviderId: string | undefined;
  let runtime: ModelRuntime | undefined;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;

  const initializeEffect = Effect.gen(function*() {
    if (shuttingDown) return yield* failure("runtime_unavailable");
    const derived = yield* compileDerivedPiModelConfig(snapshot.settings).pipe(
      Effect.mapError(compilerFailure),
    );
    const modelsPath = yield* writeDerivedModelConfig(
      snapshot.agentDirectory,
      serializeDerivedPiModelConfig(derived),
    );
    const compiled = yield* compileDefaultModelProfile(snapshot.settings, {
      credentials,
      env: options.env,
    }).pipe(Effect.mapError(compilerFailure));
    const environmentCredential = compiled.credential.source === "environment"
      ? compiled.credential.apiKey
      : undefined;
    const created = yield* Effect.tryPromise({
      try: (signal) => runtimeFactory({
        credentials,
        modelsPath,
        modelsStorePath: join(snapshot.agentDirectory, "models-store.json"),
        allowModelNetwork: false,
        refreshOnCreate: true,
        signal,
      }),
      catch: () => failure("runtime_unavailable"),
    }).pipe(Effect.tapError(() => Effect.sync(() => {
      if (environmentCredential !== undefined) Redacted.wipeUnsafe(environmentCredential);
    })));
    if (created.getError() !== undefined) {
      if (environmentCredential !== undefined) Redacted.wipeUnsafe(environmentCredential);
      return yield* failure("configuration_invalid");
    }

    const providerId = compiled.model.provider;
    if (environmentCredential !== undefined) {
      try {
        yield* Effect.tryPromise({
          try: async (signal) => {
            try {
              await created.setRuntimeApiKey(providerId, Redacted.value(environmentCredential), { signal });
            } catch (error) {
              await created.removeRuntimeApiKey(providerId).catch(() => undefined);
              throw error;
            }
          },
          catch: () => failure("runtime_unavailable"),
        });
        environmentProviderId = providerId;
      } finally {
        Redacted.wipeUnsafe(environmentCredential);
      }
    }

    const model = created.getModel(providerId, compiled.model.id);
    if (model === undefined) {
      if (environmentProviderId !== undefined) {
        yield* Effect.promise(() => created.removeRuntimeApiKey(environmentProviderId!).catch(() => undefined));
        environmentProviderId = undefined;
      }
      return yield* failure("configuration_invalid");
    }
    runtime = created;
    const sessionFactory = sessionFactoryBuilder({
      agentDirectory: snapshot.agentDirectory,
      modelRuntime: created,
      profile: {
        profileId: compiled.profileId,
        model,
        thinkingLevel: compiled.thinkingLevel,
      },
    });
    return {
      modelRuntime: created,
      sessionFactory,
      profileId: compiled.profileId,
      providerId,
      modelId: model.id,
    } satisfies InitializedFolioAgentRuntime;
  });

  const initialize = Effect.tryPromise({
    try: () => {
      initialized ??= Effect.runPromise(initializeEffect);
      return initialized;
    },
    catch: (error) => error instanceof AgentRuntimeCompositionError
      ? error
      : failure("runtime_unavailable"),
  });

  const sessionFactory: PiSessionFactory = {
    create: (cwd) => initialize.pipe(
      Effect.flatMap(({ sessionFactory: factory }) => factory.create(cwd)),
      Effect.mapError(() => new PiSessionFactoryError({
        reason: "session_unavailable",
        message: "Pi session could not be created.",
      })),
    ),
  };

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      await initialized?.catch(() => undefined);
      const providerId = environmentProviderId;
      environmentProviderId = undefined;
      if (providerId !== undefined && runtime !== undefined) {
        await runtime.removeRuntimeApiKey(providerId).catch(() => undefined);
      }
      runtime = undefined;
    })();
    return shutdownPromise;
  };

  return { initialize, sessionFactory, shutdown };
};
