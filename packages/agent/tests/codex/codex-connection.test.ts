import { NodeServices } from "@effect/platform-node";
import { Effect, Fiber, Logger, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { openCodexConnection } from "../../src/codex/connection.js";

const executable = fileURLToPath(new URL("../fixtures/codex-app-server.mjs", import.meta.url));
const cwd = fileURLToPath(new URL(".", import.meta.url));

/** Reuses the production process service with Node as the fixture executable on every platform. */
const openFixture = (requestTimeoutMs?: number) => Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* openCodexConnection({ cwd, requestTimeoutMs }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
      ...spawner,
      spawn: () => spawner.spawn(ChildProcess.make(process.execPath, [executable], {
        cwd, forceKillAfter: "2 seconds",
      })),
    }),
  );
});

it("routes out-of-order responses by ID and kills the process when its Scope closes", async () => {
  let pid = 0;
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const connection = yield* openFixture();
    pid = connection.pid;
    expect(() => process.kill(pid, 0)).not.toThrow();
    const slow = yield* connection.request("slow", { text: "slow" }).pipe(Effect.forkScoped);
    const fast = yield* connection.request("echo", { text: "fast" });
    expect(fast).toEqual({ text: "fast" });
    expect(yield* Fiber.join(slow)).toEqual({ text: "slow" });
  })).pipe(Effect.provide(NodeServices.layer)));
  expect(() => process.kill(pid, 0)).toThrow();
});

it("drains diagnostics and routes notifications independently of request acknowledgements", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const connection = yield* openFixture();
    const result = yield* connection.request("events", { text: "visible" });
    expect(result).toEqual({ text: "visible" });
    const events = yield* connection.events.pipe(Stream.take(1), Stream.runCollect);
    expect(events).toEqual([{ method: "native/update", params: { text: "visible" }, id: undefined }]);
  })).pipe(Effect.provide(NodeServices.layer)));
});

it("delivers native server requests and preserves string IDs in responses", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const connection = yield* openFixture();
    expect(yield* connection.request("server-request", { question: "input" })).toBeNull();
    const incoming = yield* connection.events.pipe(Stream.take(1), Stream.runCollect);
    expect(incoming[0]).toMatchObject({ id: "server-1", method: "native/question" });
    yield* connection.reject(incoming[0]!.id!);
    const reply = yield* connection.events.pipe(Stream.take(1), Stream.runCollect);
    expect(reply[0]).toMatchObject({ method: "answered", params: {
      id: "server-1", error: { code: -32601, message: "Unsupported request" },
    } });
  })).pipe(Effect.provide(NodeServices.layer)));
});

it("keeps protocol request failures secret-free without breaking subsequent requests", async () => {
  const logs: unknown[] = [];
  const logger = Logger.make(({ message }) => { logs.push(message); });
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const connection = yield* openFixture();
    const error = yield* connection.request("error", { password: 'fixture-secret' }).pipe(Effect.flip);
    expect(error.reason).toBe("request_failed");
    expect(JSON.stringify(error)).not.toContain("private");
    expect(yield* connection.request("echo", "still connected")).toBe("still connected");
  })).pipe(Effect.provide(NodeServices.layer), Effect.provide(Logger.layer([logger]))));
  const text = JSON.stringify(logs);
  expect(text).toContain('Codex request started');
  expect(text).toContain('Codex request completed');
  expect(text).toContain('Codex request failed');
  expect(text).toContain('request_failed');
  expect(text).toContain('elapsedMs');
  expect(text).not.toContain('fixture-secret');
  expect(text).not.toContain('private');
});

it.each([
  ["exit", "closed"], ["close-output", "closed"], ["malformed", "protocol_error"], ["unknown-id", "protocol_error"], ["hang", "timeout"],
] as const)("fails all waiters on %s without retrying", async (method, reason) => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const connection = yield* openFixture(500);
    const pending = yield* connection.request("hang", {}).pipe(Effect.flip, Effect.forkScoped);
    const error = yield* connection.request(method, {}).pipe(Effect.flip);
    expect(error.reason).toBe(reason);
    expect((yield* Fiber.join(pending)).reason).toBe(reason);
    expect((yield* connection.request("echo", {}).pipe(Effect.flip)).reason).toBe(reason);
    expect(JSON.stringify(error)).not.toContain("private");
  })).pipe(Effect.provide(NodeServices.layer)));
});

it("returns a stable startup failure for a missing executable", async () => {
  const error = await Effect.runPromise(openCodexConnection({ executable: "/missing/folio-codex", cwd }).pipe(
    Effect.scoped, Effect.provide(NodeServices.layer), Effect.flip,
  ));
  expect(error.reason).toBe("spawn_failed");
  expect(JSON.stringify(error)).not.toContain("/missing");
});
