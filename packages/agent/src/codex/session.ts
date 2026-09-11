import { Effect, Schema } from "effect";
import { realpath } from "node:fs/promises";
import { openCodexConnection, type CodexConnectionOptions } from "./connection.js";
import { loadCodexSkills } from "./skills.js";

const Thread = Schema.Struct({ id: Schema.NonEmptyString, cwd: Schema.String, ephemeral: Schema.Boolean });
const ReadResult = Schema.Struct({ thread: Thread });
const SkillsPolicy = Schema.Struct({ config: Schema.Struct({
  skills: Schema.Struct({ include_instructions: Schema.Literal(false) }),
}) });
const SessionResult = Schema.Struct({
  thread: Thread,
  cwd: Schema.String,
  model: Schema.NonEmptyString,
  modelProvider: Schema.NonEmptyString,
  approvalPolicy: Schema.Literal("never"),
  sandbox: Schema.Struct({ type: Schema.Literal("dangerFullAccess") }),
});

/** Rejects mismatched native identity/environment without exposing native paths or transcript text. */
export class CodexSessionError extends Schema.TaggedError<CodexSessionError>()("CodexSessionError", {
  reason: Schema.Literals(["invalid_session", "identity_mismatch", "cwd_mismatch"]),
  message: Schema.String,
}) {}
const failure = (reason: CodexSessionError["reason"]) => new CodexSessionError({
  reason, message: `Codex session could not be opened (${reason}).`,
});

/** Compares physical directories, allowing OS aliases such as /var and /private/var. */
const sameDirectory = Effect.fn("CodexSession.sameDirectory")(function*(actual: string, expected: string) {
  const equal = yield* Effect.tryPromise({
    try: async () => (await realpath(actual)) === (await realpath(expected)),
    catch: () => failure("cwd_mismatch"),
  });
  if (!equal) return yield* failure("cwd_mismatch");
});

export interface CodexSessionOptions extends CodexConnectionOptions {
  readonly skillPaths?: readonly string[];
  /** The resumable native thread.id, not Codex's session-tree grouping ID or a Folio/ACP ID. */
  readonly nativeSessionId?: string;
}

/**
 * Binds one scoped native process to one persistent Codex thread. Resume reads the original cwd
 * before sending any configuration override, so Codex cannot silently rebind another Task's thread.
 * It never starts a turn or resends a prompt; model selection follows the local Codex configuration.
 */
export const openCodexSession = Effect.fn("CodexSession.open")(function*(options: CodexSessionOptions) {
  const connection = yield* openCodexConnection(options);
  return yield* Effect.gen(function*() {
    // Check the effective process/project config before creating or resuming native history.
    yield* connection.request("config/read", { cwd: options.cwd, includeLayers: false }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(SkillsPolicy)), Effect.mapError(() => failure("invalid_session")),
    );
    const requestedId = options.nativeSessionId;
    if (requestedId !== undefined) {
      if (requestedId.length === 0) return yield* failure("invalid_session");
      const original = yield* connection.request("thread/read", { threadId: requestedId, includeTurns: false }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ReadResult)),
        Effect.mapError(() => failure("invalid_session")),
      );
      if (original.thread.id !== requestedId) return yield* failure("identity_mismatch");
      if (original.thread.ephemeral) return yield* failure("invalid_session");
      yield* sameDirectory(original.thread.cwd, options.cwd);
    }
    const skills = yield* loadCodexSkills(connection, options.cwd, options.skillPaths ?? []).pipe(
      Effect.mapError(() => failure("invalid_session")),
    );
    const result = yield* connection.request(requestedId === undefined ? "thread/start" : "thread/resume", {
      ...(requestedId === undefined ? { ephemeral: false } : { threadId: requestedId }),
      cwd: options.cwd, sandbox: "danger-full-access", approvalPolicy: "never",
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(SessionResult)),
      Effect.mapError(() => failure("invalid_session")),
    );
    if (requestedId !== undefined && result.thread.id !== requestedId) return yield* failure("identity_mismatch");
    if (result.thread.ephemeral) return yield* failure("invalid_session");
    yield* sameDirectory(result.cwd, options.cwd);
    yield* sameDirectory(result.thread.cwd, options.cwd);
    return {
      connection,
      skills,
      nativeSessionId: result.thread.id,
      model: result.model,
      provider: result.modelProvider,
    };
  }).pipe(Effect.tapError(() => connection.close));
});
