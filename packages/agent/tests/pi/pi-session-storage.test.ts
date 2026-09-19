import { Effect } from "effect";
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { openPiSessionStorage, type PiSessionIdentity } from "../../src/pi/session-storage.js";

const roots: string[] = [];

/** Supplies a Vault-like directory separate from its worktree; every fixture is deleted after use. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "folio-pi-storage-"));
  roots.push(root);
  return { root, cwd: join(root, "worktrees", "task"), directory: join(root, "sessions") };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Pi native storage boundary", () => {
  it("durably stores identity and an interrupted user prompt before an assistant response exists", async () => {
    const options = await fixture();
    const first = await Effect.runPromise(openPiSessionStorage(options));
    const identity: PiSessionIdentity = {
      nativeSessionId: first.getSessionId(), nativeSessionFile: first.getSessionFile()!,
    };
    await expect(access(identity.nativeSessionFile)).resolves.toBeUndefined();
    first.appendMessage({ role: "user", content: "Do not replay this prompt automatically", timestamp: 1 });
    const second = await Effect.runPromise(openPiSessionStorage({ ...options, resume: identity }));
    expect(second.getSessionId()).toBe(identity.nativeSessionId);
    expect(second.getEntries()).toMatchObject([{ type: "message", message: { role: "user", content: "Do not replay this prompt automatically" } }]);
    expect((await stat(identity.nativeSessionFile)).mode & 0o777).toBe(0o600);
    expect((await stat(options.directory)).mode & 0o777).toBe(0o700);
  });

  it("fails a missing resume without creating either the directory or a replacement session", async () => {
    const options = await fixture();
    const file = join(options.directory, "missing.jsonl");
    await expect(Effect.runPromise(openPiSessionStorage({ ...options, resume: {
      nativeSessionId: "missing", nativeSessionFile: file,
    } }))).rejects.toMatchObject({ reason: "session_missing" });
    await expect(access(options.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects mismatched native ID or worktree and leaves the original file unchanged", async () => {
    const options = await fixture();
    const session = await Effect.runPromise(openPiSessionStorage(options));
    const resume = { nativeSessionId: session.getSessionId(), nativeSessionFile: session.getSessionFile()! };
    const before = await readFile(resume.nativeSessionFile, "utf8");
    await expect(Effect.runPromise(openPiSessionStorage({ ...options, resume: { ...resume, nativeSessionId: "wrong" } })))
      .rejects.toMatchObject({ reason: "identity_mismatch" });
    await expect(Effect.runPromise(openPiSessionStorage({ ...options, cwd: join(options.root, "another-task"), resume })))
      .rejects.toMatchObject({ reason: "cwd_mismatch" });
    expect(await readFile(resume.nativeSessionFile, "utf8")).toBe(before);
  });

  it.each(["", "not-a-session secret-sentinel"])("rejects empty/invalid files without repair or secret-bearing errors", async (content) => {
    const options = await fixture();
    await mkdir(options.directory);
    const file = join(options.directory, "invalid.jsonl");
    await writeFile(file, content);
    const error = await Effect.runPromise(Effect.flip(openPiSessionStorage({ ...options, resume: {
      nativeSessionId: "expected", nativeSessionFile: file,
    } })));
    expect(error.reason).toBe("invalid_session");
    expect(JSON.stringify(error)).not.toContain("secret-sentinel");
    expect(await readFile(file, "utf8")).toBe(content);
  });

  it("rejects a different session root and a symlink instead of loading another session", async () => {
    const options = await fixture();
    const session = await Effect.runPromise(openPiSessionStorage(options));
    const resume = { nativeSessionId: session.getSessionId(), nativeSessionFile: session.getSessionFile()! };
    await expect(Effect.runPromise(openPiSessionStorage({ ...options, directory: join(options.root, "other"), resume })))
      .rejects.toMatchObject({ reason: "invalid_path" });
    const link = join(options.directory, "linked.jsonl");
    await symlink(resume.nativeSessionFile, link);
    await expect(Effect.runPromise(openPiSessionStorage({ ...options, resume: { ...resume, nativeSessionFile: link } })))
      .rejects.toMatchObject({ reason: "invalid_session" });
  });
});
