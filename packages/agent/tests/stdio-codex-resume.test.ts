import { methods } from "@agentclientprotocol/sdk/experimental/v2";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { withServer } from "./support/stdio-server.js";

// This test supplies a POSIX executable fixture. The transport/Session tests use Node directly on all platforms.
it.skipIf(process.platform === "win32")("runs the Codex CLI branch without Pi configuration and restores its archive across CLI restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "folio-stdio-codex-"));
  try {
    const executable = join(directory, "native-codex");
    const source = await readFile(new URL("./fixtures/codex-app-server.mjs", import.meta.url), "utf8");
    await writeFile(executable, `#!/usr/bin/env node\n${source}`, { mode: 0o700 });
    await mkdir(join(directory, 'selected'));
    const selected = join(directory, 'selected/SKILL.md');
    await writeFile(selected, '---\nname: selected\ndescription: Selected fixture\n---\n');
    const options = { args: ["--agent", "codex"], env: { FOLIO_CODEX_EXECUTABLE: executable,
      FOLIO_SESSION_SKILL_PATHS: JSON.stringify([selected]) } };
    const first = await withServer(directory, async (context, updates) => {
      const session = await context.request(methods.agent.session.new, { cwd: directory });
      expect(session._meta?.["folio/nativeSessionId"]).toBe("native-thread");
      await context.request(methods.agent.session.prompt, { sessionId: session.sessionId, prompt: [{ type: "text", text: "early-completion" }] });
      expect(updates.at(-1)).toMatchObject({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
      expect(JSON.parse(await readFile(join(directory, 'turn-input.json'), 'utf8'))).toEqual([
        { type: 'text', text: 'early-completion', text_elements: [] },
        { type: 'skill', name: 'selected', path: await realpath(selected) },
      ]);
      await withServer(directory, async (contender) => {
        await expect(contender.request(methods.agent.session.resume, {
          sessionId: session.sessionId, cwd: directory,
        })).rejects.toMatchObject({ data: { reason: "session_busy" } });
        await context.request(methods.agent.session.close, { sessionId: session.sessionId });
        const acquired = await contender.request(methods.agent.session.resume, {
          sessionId: session.sessionId, cwd: directory,
        });
        expect(acquired._meta).toEqual(session._meta);
        await contender.request(methods.agent.session.close, { sessionId: session.sessionId });
      }, options);
      return { session, updates: [...updates] };
    }, options);
    await withServer(directory, async (context, updates) => {
      const restored = await context.request(methods.agent.session.resume, {
        sessionId: first.session.sessionId, cwd: directory, replayFrom: { type: "start" },
      });
      expect(restored._meta).toEqual(first.session._meta);
      expect(updates).toEqual(first.updates);
      const listed = await context.request(methods.agent.session.list, {});
      expect(listed.sessions.map(({ sessionId }) => sessionId)).toContain(first.session.sessionId);
      await context.request(methods.agent.session.close, { sessionId: first.session.sessionId });
    }, options);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 15_000);
