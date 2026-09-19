import { NodeServices } from "@effect/platform-node";
import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { openCodexSession, type CodexSessionOptions } from "../../src/codex/session.js";

const executable = fileURLToPath(new URL("../fixtures/codex-app-server.mjs", import.meta.url));
const roots: string[] = [];

/** Creates isolated native state for each subprocess test, removed after the test. */
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "folio-codex-session-"));
  roots.push(path);
  return path;
}

/** Changes only the spawned executable; native request routing and lifecycle code stay in use. */
const openFixture = (options: CodexSessionOptions) => Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* openCodexSession(options).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
    ...spawner,
    spawn: () => spawner.spawn(ChildProcess.make(process.execPath, [executable], {
      cwd: options.cwd, forceKillAfter: "2 seconds",
    })),
  }));
});

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it('refuses native startup when effective config still injects the automatic Skill catalog', async () => {
  const cwd = await directory();
  await writeFile(join(cwd, 'automatic-skills.json'), 'true');
  const error = await Effect.runPromise(openFixture({ cwd }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.flip));
  expect(error).toMatchObject({ reason: 'invalid_session' });
  await expect(access(join(cwd, 'native-thread.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it("creates with full access and resumes the same native thread in a new process without starting a turn", async () => {
  const cwd = await directory();
  const first = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const session = yield* openFixture({ cwd });
    const opened = yield* session.connection.events.pipe(Stream.take(1), Stream.runCollect);
    expect(opened[0]).toMatchObject({ method: "fixture/opened", params: {
      cwd, ephemeral: false, sandbox: "danger-full-access", approvalPolicy: "never",
    } });
    expect(session.model).toBe("configured-model");
    return { id: session.nativeSessionId, pid: session.connection.pid };
  })).pipe(Effect.provide(NodeServices.layer)));
  const second = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const session = yield* openFixture({ cwd, nativeSessionId: first.id });
    return { id: session.nativeSessionId, pid: session.connection.pid };
  })).pipe(Effect.provide(NodeServices.layer)));
  expect(second.id).toBe(first.id);
  expect(second.pid).not.toBe(first.pid);
  expect(JSON.parse(await readFile(join(cwd, "resumed.json"), "utf8"))).toEqual({
    threadId: first.id, cwd, sandbox: "danger-full-access", approvalPolicy: "never",
  });
  expect(() => process.kill(first.pid, 0)).toThrow();
  expect(() => process.kill(second.pid, 0)).toThrow();
});

it.each([
  ["missing", undefined, "invalid_session"],
  ["different-id", { id: "other", ephemeral: false }, "identity_mismatch"],
  ["different-cwd", { id: "native", cwd: "/", ephemeral: false }, "cwd_mismatch"],
  ["ephemeral", { id: "native", ephemeral: true }, "invalid_session"],
] as const)("rejects %s before issuing resume or creating replacement native state", async (_name, stored, reason) => {
  const cwd = await directory();
  const path = join(cwd, "native-thread.json");
  const source = stored === undefined ? undefined : JSON.stringify({ cwd, ...stored });
  if (source !== undefined) await writeFile(path, source);
  const error = await Effect.runPromise(openFixture({ cwd, nativeSessionId: "native" }).pipe(
    Effect.scoped, Effect.provide(NodeServices.layer), Effect.flip,
  ));
  expect(error.reason).toBe(reason);
  await expect(access(join(cwd, "resumed.json"))).rejects.toMatchObject({ code: "ENOENT" });
  if (source !== undefined) expect(await readFile(path, "utf8")).toBe(source);
  else await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([
  { approvalPolicy: "on-request" }, { sandbox: { type: "workspaceWrite" } },
])("rejects a native policy that does not match first-release full access: %j", async (policy) => {
  const cwd = await directory();
  await writeFile(join(cwd, "native-thread.json"), JSON.stringify({ cwd, id: "native", ephemeral: false, ...policy }));
  const error = await Effect.runPromise(openFixture({ cwd, nativeSessionId: "native" }).pipe(
    Effect.scoped, Effect.provide(NodeServices.layer), Effect.flip,
  ));
  expect(error.reason).toBe("invalid_session");
});
