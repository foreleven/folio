import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const roots: string[] = [];

/** Runs the installed Pi SDK in a fresh process, proving persistence beyond in-memory objects. */
async function piProcess(source: string, ...args: string[]): Promise<unknown> {
  const result = await execute(process.execPath, ["--input-type=module", "-e", source, ...args], {
    cwd: process.cwd(), timeout: 15_000,
  });
  return JSON.parse(result.stdout.trim());
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Harness V0: installed Pi native session persistence", () => {
  it("restores a persisted native ID, cwd and messages in a second process", async () => {
    const root = await mkdtemp(join(tmpdir(), "folio-pi-persistence-"));
    roots.push(root);
    const cwd = join(root, "worktree");
    const directory = join(root, "sessions");
    const created = await piProcess(`
      import { SessionManager } from '@earendil-works/pi-coding-agent';
      import { existsSync } from 'node:fs';
      const session = SessionManager.create(process.argv[1], process.argv[2]);
      session.appendMessage({ role: 'user', content: 'Fixture question', timestamp: 1 });
      const persistedBeforeAssistant = existsSync(session.getSessionFile());
      session.appendMessage({
        role: 'assistant', content: [{ type: 'text', text: 'Fixture answer' }],
        api: 'openai-completions', provider: 'fixture', model: 'fixture', timestamp: 2,
        stopReason: 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
      });
      console.log(JSON.stringify({ id: session.getSessionId(), file: session.getSessionFile(), persistedBeforeAssistant }));
    `, cwd, directory) as { id: string; file: string; persistedBeforeAssistant: boolean };

    expect(created.persistedBeforeAssistant).toBe(false);
    expect(created.file.startsWith(directory)).toBe(true);
    const resumed = await piProcess(`
      import { SessionManager } from '@earendil-works/pi-coding-agent';
      const session = SessionManager.open(process.argv[1], process.argv[2]);
      console.log(JSON.stringify({ id: session.getSessionId(), cwd: session.getCwd(),
        messages: session.getEntries().filter(e => e.type === 'message').map(e => e.message) }));
    `, created.file, directory) as { id: string; cwd: string; messages: unknown[] };

    expect(resumed.id).toBe(created.id);
    expect(resumed.cwd).toBe(cwd);
    expect(resumed.messages).toMatchObject([
      { role: "user", content: "Fixture question" },
      { role: "assistant", content: [{ type: "text", text: "Fixture answer" }] },
    ]);
  });

  it("documents why Folio must reject missing resume files before calling SessionManager.open", async () => {
    const root = await mkdtemp(join(tmpdir(), "folio-pi-missing-session-"));
    roots.push(root);
    const result = await piProcess(`
      import { SessionManager } from '@earendil-works/pi-coding-agent';
      const session = SessionManager.open(process.argv[1], process.argv[2]);
      console.log(JSON.stringify({ id: session.getSessionId(), entries: session.getEntries().length }));
    `, join(root, "missing.jsonl"), root);
    // The SDK silently constructs a new session: a successful call does not prove restoration.
    expect(result).toMatchObject({ id: expect.any(String), entries: 0 });
  });
});
