import { Effect, Redacted, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { join } from "node:path";
import { loadFolioAgentConfig } from "./config/loader.js";
import { SystemOneGoal, type SystemOneConfig } from "./config/schema.js";
import { SecureCredentialStore } from "./model/credential-store.js";
import type { PiToolExecutor } from "./pi/host-tools.js";

export const SYSTEM_ONE_CREDENTIAL_ID = "folio-system-one";
export const KNOWLEDGE_MATCH_THRESHOLD = 0.7;
export const SystemOneInput = Schema.Struct({
  rawRef: Schema.NonEmptyString,
  context: Schema.NonEmptyString,
  goals: Schema.Array(SystemOneGoal).check(Schema.isMinLength(1)),
}).check(Schema.makeFilter(value => new Set(value.goals.map(goal => goal.id)).size === value.goals.length,
  { expected: "unique goal IDs" }));
export type SystemOneInput = typeof SystemOneInput.Type;
const Answer = Schema.Struct({ type: Schema.Literal("noul"), noul: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })) });
const Response = Schema.Struct({ model: Schema.NonEmptyString, answers: Schema.Record(Schema.String, Answer) });

/** Native tools share this schema; Effect decoding remains the authority at the host boundary. */
export const systemOneToolSpec = {
  type: "function" as const,
  name: "system_one",
  description: "Judge frozen raw source material against independent Knowledge goals. Provide original source context and goal descriptions. Returns each goal's match probability and matched=true at probability >= 0.7. Does not write Wiki content or todos. Errors do not mean no match.",
  inputSchema: Schema.toJsonSchemaDocument(SystemOneInput).schema,
};

/** Finite, credential-free errors are safe to return to an Agent and persist in its tool history. */
export class SystemOneError extends Schema.TaggedError<SystemOneError>()("SystemOneError", {
  reason: Schema.Literals(["not_configured", "credential_unavailable", "invalid_input", "transport", "http", "invalid_response", "timeout"]),
  stage: Schema.Literals(["configuration", "credential", "request", "decode"]),
  status: Schema.optionalKey(Schema.Int),
  message: Schema.String,
}) {}
const failure = (reason: SystemOneError["reason"], stage: SystemOneError["stage"], status?: number) => new SystemOneError({
  reason, stage, ...(status === undefined ? {} : { status }),
  message: `System One failed at ${stage} (${reason}${status === undefined ? "" : `, HTTP ${status}`}). Check Agent Settings or retry; this is not a negative goal match.`,
});

/** Noul questions are independent, so one source context can evaluate several goals in one request. */
export const evaluateSystemOne = Effect.fn("SystemOne.evaluate")(function*(config: SystemOneConfig,
  apiKey: Redacted.Redacted<string>, rawInput: unknown) {
  const input = yield* Schema.decodeUnknownEffect(SystemOneInput)(rawInput, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => failure("invalid_input", "request")));
  const client = yield* HttpClient.HttpClient;
  // Accept an API origin or the conventional /v1 base without appending /v1 twice.
  const base = config.baseUrl.replace(/\/+$/, "");
  const endpoint = `${base}${base.endsWith("/v1") ? "" : "/v1"}/systemone`;
  const questions = Object.fromEntries(input.goals.map(goal => [goal.id, {
    type: "noul",
    instructions: `Does the original source material contain evidence worth curating under this Knowledge goal?\n${goal.description}\nEvaluate the new material with its supplied source context. A mere entity mention or the possibility of summarizing text is not sufficient.`,
    criteria: { true: "The source contains concrete material that warrants curation under the goal.",
      false: "The source does not contain sufficient material for this goal." },
  }]));
  const request = HttpClientRequest.post(endpoint).pipe(
    HttpClientRequest.setHeader("authorization", `Bearer ${Redacted.value(apiKey)}`),
    HttpClientRequest.bodyJsonUnsafe({ model: config.model, state: { rawRef: input.rawRef, context: input.context }, questions }),
  );
  const send = Effect.gen(function*() {
    const response = yield* client.execute(request).pipe(Effect.mapError(() => failure("transport", "request")));
    if (response.status < 200 || response.status >= 300) return yield* failure("http", "request", response.status);
    const json = yield* response.json.pipe(Effect.mapError(() => failure("invalid_response", "decode")));
    const decoded = yield* Schema.decodeUnknownEffect(Response)(json).pipe(Effect.mapError(() => failure("invalid_response", "decode")));
    if (input.goals.some(goal => !Object.hasOwn(decoded.answers, goal.id)) || Object.keys(decoded.answers).length !== input.goals.length)
      return yield* failure("invalid_response", "decode");
    return { rawRef: input.rawRef, model: decoded.model, results: input.goals.map(goal => {
      const probability = decoded.answers[goal.id]!.noul;
      return { goalId: goal.id, probability, matched: probability >= KNOWLEDGE_MATCH_THRESHOLD };
    }) };
  });
  const result = yield* send.pipe(Effect.retry(Schedule.max([Schedule.exponential("250 millis"), Schedule.recurs(2)]).pipe(
    Schedule.setInputType<SystemOneError>(), Schedule.while(({ input: error }) =>
      error.reason === "transport" || (error.reason === "http" && (error.status === 429 || (error.status ?? 0) >= 500))),
  )), Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => Effect.fail(failure("timeout", "request")) }));
  yield* Effect.logDebug("System One goal matching completed", { goalCount: input.goals.length,
    matchedCount: result.results.filter(answer => answer.matched).length });
  return result;
}, Effect.tapError(error => Effect.logError("System One goal matching failed", {
  reason: error.reason, stage: error.stage, status: error.status,
})));

/** Reads current host-owned connection settings and credentials; neither crosses the Worker boundary. */
export function makeSystemOneToolExecutor(configDirectory: string, agentDirectory: string): PiToolExecutor {
  const credentials = new SecureCredentialStore({ authPath: join(agentDirectory, "auth.json") });
  return async (name, _callId, params, signal) => {
    if (name !== systemOneToolSpec.name) throw new Error("Unknown System One tool.");
    const program = Effect.gen(function*() {
      const snapshot = yield* loadFolioAgentConfig({ env: { FOLIO_CONFIG_DIR: configDirectory, FOLIO_AGENT_DIR: agentDirectory } }).pipe(
        Effect.mapError(() => failure("not_configured", "configuration")));
      if (!snapshot.settings.systemOne) return yield* failure("not_configured", "configuration");
      const credential = yield* Effect.tryPromise({ try: signal => credentials.read(SYSTEM_ONE_CREDENTIAL_ID, { signal }),
        catch: () => failure("credential_unavailable", "credential") });
      if (credential?.type !== "api_key" || !credential.key) return yield* failure("credential_unavailable", "credential");
      return yield* evaluateSystemOne(snapshot.settings.systemOne, Redacted.make(credential.key), params);
    }).pipe(
      Effect.tapError(error => error.stage === "configuration" || error.stage === "credential"
        ? Effect.logError("System One goal matching failed", { reason: error.reason, stage: error.stage })
        : Effect.void),
      Effect.provide(FetchHttpClient.layer),
    );
    try {
      const value = await Effect.runPromise(program, { signal });
      return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
    } catch (error) {
      // eslint-disable-next-line preserve-caught-error -- Persisted tool errors must exclude raw request and credential failures.
      if (signal?.aborted) throw new Error("System One call cancelled.");
      throw error instanceof SystemOneError ? error : failure("transport", "request");
    }
  };
}
