import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Effect, Schema } from "effect";
import {
  PI_ACP_PROMPT_OPTIONS,
  type PiSessionFactory,
  type PiSessionRuntime,
} from "../pi/session-factory.js";

export const SessionRegistryFailureReason = Schema.Literals([
  "session_exists",
  "session_not_found",
  "session_busy",
  "session_closed",
  "session_unavailable",
  "prompt_failed",
  "config_option_unsupported",
  "config_value_unsupported",
  "config_update_failed",
]);
export type SessionRegistryFailureReason = typeof SessionRegistryFailureReason.Type;

/** Stable Registry failure which never retains prompt text, provider errors, or credentials. */
export class SessionRegistryError extends Schema.TaggedError<SessionRegistryError>()(
  "SessionRegistryError",
  {
    reason: SessionRegistryFailureReason,
    message: Schema.String,
  },
) {}

const failureMessage: Record<SessionRegistryFailureReason, string> = {
  session_exists: "Session already exists.",
  session_not_found: "Session was not found.",
  session_busy: "Session already has foreground work.",
  session_closed: "Session is closed.",
  session_unavailable: "Session could not be created.",
  prompt_failed: "Session prompt failed.",
  config_option_unsupported: "Session configuration option is unsupported.",
  config_value_unsupported: "Session configuration value is unsupported.",
  config_update_failed: "Session configuration could not be updated.",
};

const failure = (reason: SessionRegistryFailureReason): SessionRegistryError =>
  new SessionRegistryError({ reason, message: failureMessage[reason] });

export type SessionRegistryState = "idle" | "prompting" | "configuring" | "cancelling" | "closed";

export interface SessionRegistryEntryView {
  readonly sessionId: string;
  readonly cwd: string;
  readonly state: SessionRegistryState;
}

interface SessionRegistryEntry {
  readonly sessionId: string;
  readonly cwd: string;
  readonly piSession: PiSessionRuntime;
  unsubscribe: () => void;
  state: SessionRegistryState;
  work?: Promise<void>;
  cancelRequested: boolean;
  events: Promise<void>;
}

export interface SessionRegistryOptions {
  readonly sessionFactory: PiSessionFactory;
  readonly onEvent: (sessionId: string, event: AgentSessionEvent) => void | Promise<void>;
}

export type SessionPromptStopReason = "end_turn" | "cancelled";

export interface SessionPromptHandle {
  readonly completion: Promise<SessionPromptStopReason>;
}

export interface SessionModelOption {
  readonly value: string;
  readonly name: string;
}

export interface SessionConfigSnapshot {
  readonly modelValue: string;
  readonly models: readonly SessionModelOption[];
  readonly thinkingLevel: string;
  readonly thinkingLevels: readonly string[];
}

export type SessionConfigMutation =
  | { readonly configId: "model"; readonly value: string }
  | { readonly configId: "thought_level"; readonly value: string };

export interface SessionRegistry {
  readonly create: (sessionId: string, cwd: string) => Effect.Effect<SessionRegistryEntryView, SessionRegistryError>;
  readonly get: (sessionId: string) => Effect.Effect<SessionRegistryEntryView, SessionRegistryError>;
  readonly list: () => readonly SessionRegistryEntryView[];
  readonly config: (sessionId: string) => Effect.Effect<SessionConfigSnapshot, SessionRegistryError>;
  readonly setConfig: (
    sessionId: string,
    mutation: SessionConfigMutation,
  ) => Effect.Effect<SessionConfigSnapshot, SessionRegistryError>;
  readonly prompt: (
    sessionId: string,
    text: string,
    onAccepted?: () => void | Promise<void>,
  ) => Effect.Effect<SessionPromptHandle, SessionRegistryError>;
  readonly cancel: (sessionId: string) => Effect.Effect<void, SessionRegistryError>;
  readonly close: (sessionId: string) => Effect.Effect<void, SessionRegistryError>;
  readonly shutdown: Effect.Effect<void>;
}

const modelValue = (model: Model<Api>): string =>
  Buffer.from(JSON.stringify([model.provider, model.id]), "utf8").toString("base64url");

const configSnapshot = (entry: SessionRegistryEntry): SessionConfigSnapshot => {
  const currentModel = entry.piSession.model;
  const models = entry.piSession.availableModels.map((model) => ({
    value: modelValue(model),
    name: model.name,
  }));
  return {
    modelValue: currentModel === undefined ? "" : modelValue(currentModel),
    models,
    thinkingLevel: entry.piSession.thinkingLevel,
    thinkingLevels: entry.piSession.getAvailableThinkingLevels(),
  };
};

const entryView = (entry: SessionRegistryEntry): SessionRegistryEntryView => ({
  sessionId: entry.sessionId,
  cwd: entry.cwd,
  state: entry.state,
});

const safeUnsubscribe = (entry: SessionRegistryEntry): void => {
  try {
    entry.unsubscribe();
  } catch {
    // Unsubscribe is best-effort; disposal remains mandatory.
  }
};

const safeDispose = (entry: SessionRegistryEntry): void => {
  try {
    entry.piSession.dispose();
  } catch {
    // Disposal errors are contained so shutdown can continue releasing other sessions.
  }
};

const releaseUnregisteredSession = async (piSession: PiSessionRuntime): Promise<void> => {
  if (!piSession.isIdle) await piSession.abort().catch(() => undefined);
  await piSession.waitForIdle().catch(() => undefined);
  try {
    piSession.dispose();
  } catch {
    // The session never entered the Registry; contain disposal failure at the boundary.
  }
};

const releaseEntry = async (entry: SessionRegistryEntry): Promise<void> => {
  if (entry.state === "closed") return;
  entry.cancelRequested = true;
  if (!entry.piSession.isIdle) {
    entry.state = "cancelling";
    await entry.piSession.abort().catch(() => undefined);
  }
  await entry.work?.catch(() => undefined);
  await entry.piSession.waitForIdle().catch(() => undefined);
  safeUnsubscribe(entry);
  await entry.events.catch(() => undefined);
  safeDispose(entry);
  entry.state = "closed";
};

/**
 * Owns independent Pi sessions and their subscriptions. Registry operations are synchronous at the
 * map boundary; each entry carries its own foreground work and cancellation state so sessions never
 * share abort or completion state.
 */
export const makeSessionRegistry = ({
  sessionFactory,
  onEvent,
}: SessionRegistryOptions): SessionRegistry => {
  const entries = new Map<string, SessionRegistryEntry>();
  const creating = new Set<string>();
  const creationDrains = new Set<() => void>();
  let activeCreations = 0;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;

  const beginCreation = (sessionId: string): void => {
    creating.add(sessionId);
    activeCreations += 1;
  };
  const finishCreation = (sessionId: string): void => {
    creating.delete(sessionId);
    activeCreations -= 1;
    if (activeCreations === 0) {
      for (const resolve of creationDrains) resolve();
      creationDrains.clear();
    }
  };
  const awaitCreations = (): Promise<void> => activeCreations === 0
    ? Promise.resolve()
    : new Promise<void>((resolve) => creationDrains.add(resolve));

  const requireEntry = (sessionId: string): SessionRegistryEntry => {
    const entry = entries.get(sessionId);
    if (entry === undefined) throw failure("session_not_found");
    if (entry.state === "closed") throw failure("session_closed");
    return entry;
  };

  const create = Effect.fn("SessionRegistry.create")(function*(sessionId: string, cwd: string) {
    if (shuttingDown) return yield* failure("session_closed");
    if (entries.has(sessionId) || creating.has(sessionId)) return yield* failure("session_exists");
    beginCreation(sessionId);
    return yield* Effect.gen(function*() {
      const piSession = yield* sessionFactory.create(cwd).pipe(
        Effect.mapError(() => failure("session_unavailable")),
      );
      if (shuttingDown) {
        yield* Effect.promise(() => releaseUnregisteredSession(piSession));
        return yield* failure("session_closed");
      }
      const entry: SessionRegistryEntry = {
        sessionId,
        cwd,
        piSession,
        unsubscribe: () => undefined,
        state: "idle",
        cancelRequested: false,
        events: Promise.resolve(),
      };
      entry.unsubscribe = yield* Effect.try({
        try: () => piSession.subscribe((event) => {
          if (entry.state === "closed") return;
          entry.events = entry.events
            .then(() => onEvent(sessionId, event))
            .then(() => undefined, () => undefined);
        }),
        catch: () => failure("session_unavailable"),
      }).pipe(
        Effect.tapError(() => Effect.promise(() => releaseUnregisteredSession(piSession))),
      );
      entries.set(sessionId, entry);
      return entryView(entry);
    }).pipe(
      Effect.ensuring(Effect.sync(() => finishCreation(sessionId))),
    );
  });

  const get = Effect.fn("SessionRegistry.get")(function*(sessionId: string) {
    return entryView(yield* Effect.try({
      try: () => requireEntry(sessionId),
      catch: (error) => error instanceof SessionRegistryError ? error : failure("session_not_found"),
    }));
  });

  const list = (): readonly SessionRegistryEntryView[] => [...entries.values()]
    .filter(({ state }) => state !== "closed")
    .map(entryView);

  const config = Effect.fn("SessionRegistry.config")(function*(sessionId: string) {
    const entry = yield* Effect.try({
      try: () => requireEntry(sessionId),
      catch: (error) => error instanceof SessionRegistryError ? error : failure("session_not_found"),
    });
    return configSnapshot(entry);
  });

  const setConfig = Effect.fn("SessionRegistry.setConfig")(function*(
    sessionId: string,
    mutation: SessionConfigMutation,
  ) {
    const entry = yield* Effect.try({
      try: () => requireEntry(sessionId),
      catch: (error) => error instanceof SessionRegistryError ? error : failure("session_not_found"),
    });
    if (entry.state !== "idle" || entry.work !== undefined || !entry.piSession.isIdle) {
      return yield* failure("session_busy");
    }

    if (mutation.configId === "model") {
      const model = entry.piSession.availableModels.find(
        (candidate) => modelValue(candidate) === mutation.value,
      );
      if (model === undefined) return yield* failure("config_value_unsupported");
      entry.state = "configuring";
      const update = entry.piSession.setModel(model, { persist: false });
      const trackedWork = update.then(
        () => undefined,
        () => undefined,
      ).finally(() => {
        if (entry.state !== "closed") entry.state = "idle";
        if (entry.work === trackedWork) entry.work = undefined;
      });
      entry.work = trackedWork;
      yield* Effect.tryPromise({
        try: async () => {
          try {
            await update;
          } finally {
            await trackedWork;
          }
        },
        catch: () => failure("config_update_failed"),
      });
      return configSnapshot(entry);
    }

    if (mutation.configId === "thought_level") {
      const level = mutation.value as ModelThinkingLevel;
      if (!entry.piSession.getAvailableThinkingLevels().includes(level)) {
        return yield* failure("config_value_unsupported");
      }
      yield* Effect.try({
        try: () => entry.piSession.setThinkingLevel(level, { persist: false }),
        catch: () => failure("config_update_failed"),
      });
      return configSnapshot(entry);
    }

    return yield* failure("config_option_unsupported");
  });

  const prompt = Effect.fn("SessionRegistry.prompt")(function*(
    sessionId: string,
    text: string,
    onAccepted: () => void | Promise<void> = () => undefined,
  ) {
    const entry = yield* Effect.try({
      try: () => requireEntry(sessionId),
      catch: (error) => error instanceof SessionRegistryError ? error : failure("session_not_found"),
    });
    if (entry.state !== "idle" || entry.work !== undefined || !entry.piSession.isIdle) {
      return yield* failure("session_busy");
    }

    entry.state = "prompting";
    entry.cancelRequested = false;
    yield* Effect.tryPromise({
      try: () => Promise.resolve(onAccepted()),
      catch: () => failure("prompt_failed"),
    }).pipe(Effect.tapError(() => Effect.sync(() => {
      entry.state = "idle";
    })));
    const completion = entry.piSession.prompt(text, PI_ACP_PROMPT_OPTIONS)
      .then(async (): Promise<SessionPromptStopReason> => {
        await entry.events.catch(() => undefined);
        return entry.cancelRequested ? "cancelled" : "end_turn";
      })
      .catch(async () => {
        await entry.events.catch(() => undefined);
        if (entry.cancelRequested) return "cancelled" as const;
        throw failure("prompt_failed");
      });
    const trackedWork = completion.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      if (entry.state !== "closed") entry.state = "idle";
      if (entry.work === trackedWork) entry.work = undefined;
    });
    entry.work = trackedWork;
    const settledCompletion = completion.then(
      async (stopReason) => {
        await trackedWork;
        return stopReason;
      },
      async (error) => {
        await trackedWork;
        throw error;
      },
    );
    return { completion: settledCompletion };
  });

  const cancel = Effect.fn("SessionRegistry.cancel")(function*(sessionId: string) {
    const entry = yield* Effect.try({
      try: () => requireEntry(sessionId),
      catch: (error) => error instanceof SessionRegistryError ? error : failure("session_not_found"),
    });
    if (entry.state === "idle" && entry.work === undefined && entry.piSession.isIdle) return;
    entry.cancelRequested = true;
    entry.state = "cancelling";
    yield* Effect.promise(() => entry.piSession.abort().catch(() => undefined));
    yield* Effect.promise(() => entry.work?.catch(() => undefined) ?? Promise.resolve());
    yield* Effect.promise(() => entry.piSession.waitForIdle().catch(() => undefined));
    yield* Effect.promise(() => entry.events.catch(() => undefined));
    entry.state = "idle";
  });

  const close = Effect.fn("SessionRegistry.close")(function*(sessionId: string) {
    const entry = yield* Effect.try({
      try: () => requireEntry(sessionId),
      catch: (error) => error instanceof SessionRegistryError ? error : failure("session_not_found"),
    });
    yield* Effect.promise(() => releaseEntry(entry));
    entries.delete(sessionId);
  });

  const shutdown = Effect.promise(() => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      await awaitCreations();
      const current = [...entries.values()];
      await Promise.all(current.map(releaseEntry));
      entries.clear();
    })();
    return shutdownPromise;
  });

  return { create, get, list, config, setConfig, prompt, cancel, close, shutdown };
};
