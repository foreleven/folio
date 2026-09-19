import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const roots: string[] = [];

/** Runs real Git in an isolated fixture, without user hooks, signing, identity or Git overrides. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = await execute("git", [
    "-c", "user.name=Folio Test", "-c", "user.email=test@folio.invalid",
    "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${devNull}`,
    "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", ...args,
  ], { cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull } });
  return result.stdout.trim();
}

/** Creates main and two actual worktrees with a shared committed wiki baseline. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "folio-git-spike-"));
  roots.push(root);
  const main = join(root, "workspace");
  const a = join(root, "task-a");
  const b = join(root, "task-b");
  await mkdir(main);
  await git(main, "init", "--initial-branch=main");
  await save(main, "wiki/note.md", "Original\n");
  await commit(main, "baseline", "wiki/note.md");
  await git(main, "worktree", "add", "-b", "codex/task-a", a);
  await git(main, "worktree", "add", "-b", "codex/task-b", b);
  return { main, a, b, baseline: await git(main, "rev-parse", "HEAD") };
}

/** Writes fixture content without staging it, so dirty-worktree behavior remains observable. */
async function save(cwd: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(cwd, path)), { recursive: true });
  await writeFile(join(cwd, path), content);
}

/** Models a Folio-owned commit with an immutable logical identity in its trailer. */
async function commit(cwd: string, changeId: string, ...paths: string[]): Promise<string> {
  if (paths.length > 0) await git(cwd, "add", "--", ...paths);
  await git(cwd, "commit", "-m", `Change ${changeId}\n\nFolio-Change-Id: ${changeId}`);
  return git(cwd, "rev-parse", "HEAD");
}

/** Records the exact resulting tree instead of treating a successful Git exit as convergence. */
async function tree(cwd: string): Promise<string> {
  return git(cwd, "rev-parse", "HEAD^{tree}");
}

/** Candidate only: freezes a main baseline and applies all pending source commits in isolation. */
async function prepareCanonical(main: string, name: string,
  source: { cwd: string; frontier: string; head: string }, resolveConflict?: (cwd: string) => Promise<void>) {
  // The frontier is a previously recorded source acceptance, not an inferred patch-equivalence ID.
  // Enumerate its entire suffix: an omitted earlier source commit would otherwise be silently lost.
  await git(source.cwd, "merge-base", "--is-ancestor", source.frontier, source.head);
  const suffix = await git(source.cwd, "rev-list", "--reverse", `${source.frontier}..${source.head}`);
  const commits = suffix ? suffix.split("\n") : [];
  const base = await git(main, "rev-parse", "HEAD");
  const cwd = join(dirname(main), name);
  await git(main, "worktree", "add", "--detach", cwd, base);
  for (const sha of commits) {
    try { await git(cwd, "cherry-pick", sha); }
    catch (error) {
      if (!resolveConflict || !(await git(cwd, "diff", "--name-only", "--diff-filter=U"))) throw error;
      await resolveConflict(cwd);
      await git(cwd, "add", "--", "wiki");
      await git(cwd, "cherry-pick", "--continue");
    }
  }
  return { cwd, base, operationId: name, acceptedHead: source.head, head: await git(cwd, "rev-parse", "HEAD") };
}

/** Publishes only a still-current, clean main. Production also needs durable Git/SQL operation checkpoints. */
async function publishCanonical(main: string, prepared: Awaited<ReturnType<typeof prepareCanonical>>): Promise<void> {
  const current = await git(main, "rev-parse", "HEAD");
  if (await git(main, "status", "--porcelain", "--untracked-files=all")) throw new Error("main changed");
  if (current === prepared.head) return; // Git succeeded but its operation receipt may have been lost.
  if (current !== prepared.base) {
    throw new Error("main changed");
  }
  await git(main, "merge", "--ff-only", prepared.head);
}

/**
 * Candidate reconciliation: only after every source change is accepted into canonical main,
 * prepare a normal commit whose parent is the frozen Task HEAD and whose tree is canonical.
 * No reset or working-file overwrite is used; stale/dirty Tasks must remain untouched.
 */
async function alignAcceptedTask(task: string, accepted: Awaited<ReturnType<typeof prepareCanonical>>): Promise<string> {
  const frozenHead = accepted.acceptedHead;
  const canonical = accepted.head;
  if (await git(task, "status", "--porcelain", "--untracked-files=all")) throw new Error("task changed");
  const current = await git(task, "rev-parse", "HEAD");
  if (current !== frozenHead) {
    const message = await git(task, "log", "-1", "--format=%B");
    if (message.split("\n").includes(`Folio-Sync-Operation: ${accepted.operationId}`)
      && await git(task, "rev-parse", "HEAD^") === frozenHead
      && await tree(task) === await git(task, "rev-parse", `${canonical}^{tree}`)) return current;
    throw new Error("task changed");
  }
  if (await tree(task) === await git(task, "rev-parse", `${canonical}^{tree}`)) return frozenHead;
  const targetTree = await git(task, "rev-parse", `${canonical}^{tree}`);
  const reconciliation = await git(task, "commit-tree", targetTree, "-p", frozenHead,
    "-m", `Canonical reconciliation\n\nFolio-Sync-Operation: ${accepted.operationId}\nFolio-Canonical-Commit: ${canonical}`);
  await git(task, "cherry-pick", "--ff", reconciliation);
  return reconciliation;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Harness V0: real Git synchronization evidence", () => {
  it("converges independent task changes and avoids duplicate picks using logical identities", async () => {
    const { main, a, b } = await fixture();
    await save(a, "wiki/a.md", "From A\n");
    const ca = await commit(a, "a", "wiki/a.md");
    await save(b, "wiki/b.md", "From B\n");
    const cb = await commit(b, "b", "wiki/b.md");
    await git(main, "cherry-pick", ca);
    await git(main, "cherry-pick", cb);
    await git(a, "cherry-pick", cb);
    await git(b, "cherry-pick", ca);
    expect(await tree(a)).toBe(await tree(main));
    expect(await tree(b)).toBe(await tree(main));
    const before = await git(main, "rev-parse", "HEAD");
    const messages = await git(main, "log", "--format=%B");
    // The spike's receipt check deliberately does not claim that an ID proves equal content.
    if (!messages.includes("Folio-Change-Id: a")) await git(main, "cherry-pick", ca);
    expect(await git(main, "rev-parse", "HEAD")).toBe(before);
  });

  it("proves identical change IDs do not imply convergence after different conflict resolutions", async () => {
    const { main, a } = await fixture();
    await save(main, "wiki/note.md", "User version\n");
    const user = await commit(main, "user", "wiki/note.md");
    await save(a, "wiki/note.md", "Agent version\n");
    const agent = await commit(a, "agent", "wiki/note.md");

    await expect(git(a, "cherry-pick", user)).rejects.toBeDefined();
    await save(a, "wiki/note.md", "User version and Agent version\n");
    await git(a, "add", "--", "wiki/note.md");
    await git(a, "cherry-pick", "--continue");

    await expect(git(main, "cherry-pick", agent)).rejects.toBeDefined();
    await save(main, "wiki/note.md", "Agent version and User version\n");
    await git(main, "add", "--", "wiki/note.md");
    await git(main, "cherry-pick", "--continue");

    for (const cwd of [main, a]) {
      const history = await git(cwd, "log", "--format=%B");
      expect(history).toContain("Folio-Change-Id: user");
      expect(history).toContain("Folio-Change-Id: agent");
      expect(await git(cwd, "status", "--porcelain")).toBe("");
    }
    // A green test is evidence of the RFC's unresolved risk, not a passed production sync gate.
    expect(await tree(a)).not.toBe(await tree(main));
  });

  it("converges after resolving conflicts once in canonical main, while retaining the Task's original history", async () => {
    const { main, a, b, baseline } = await fixture();
    await save(main, "wiki/note.md", "User version\n");
    await commit(main, "user", "wiki/note.md");
    await save(a, "wiki/note.md", "Agent version\n");
    const source = await commit(a, "agent", "wiki/note.md");
    const prepared = await prepareCanonical(main, "canonical", { cwd: a, frontier: baseline, head: source }, cwd => save(cwd, "wiki/note.md", "User version and Agent version\n"));
    expect(await git(main, "rev-parse", "HEAD")).toBe(prepared.base);
    expect(await readFile(join(main, "wiki/note.md"), "utf8")).toBe("User version\n");
    await publishCanonical(main, prepared);
    const before = await git(a, "rev-parse", "HEAD");
    expect(prepared.acceptedHead).toBe(before);
    const alignment = await alignAcceptedTask(a, prepared);
    expect(await git(a, "rev-parse", `${alignment}^`)).toBe(source);
    await git(a, "merge-base", "--is-ancestor", source, "HEAD");
    expect(await tree(a)).toBe(await tree(main));
    const idleTask = await prepareCanonical(main, "idle-task", { cwd: b, frontier: baseline, head: baseline });
    await alignAcceptedTask(b, idleTask);
    expect(await tree(b)).toBe(await tree(main));
    // A recorded delivery retry does not pick the original source again or invent a new alignment.
    await publishCanonical(main, prepared);
    expect(await alignAcceptedTask(a, prepared)).toBe(alignment);
    await save(a, "wiki/note.md", "User version and Agent version\nNext task edit\n");
    const nextSource = await commit(a, "next-source", "wiki/note.md");
    // The recorded alignment is the next source frontier. It must never be exported back to main.
    const next = await prepareCanonical(main, "next-canonical", { cwd: a, frontier: alignment, head: nextSource });
    await publishCanonical(main, next);
    await alignAcceptedTask(a, next);
    expect(await tree(a)).toBe(await tree(main));
    expect(await readFile(join(main, "wiki/note.md"), "utf8")).toBe("User version and Agent version\nNext task edit\n");
    expect(await git(main, "log", "--format=%B")).not.toContain("Folio-Sync-Operation:");
  });

  it("rebuilds canonical preparation when main advances and refuses dirty or advanced Task alignment", async () => {
    const { main, a, baseline } = await fixture();
    await save(a, "wiki/a.md", "Saved source\n");
    const source = await commit(a, "source", "wiki/a.md");
    const old = await prepareCanonical(main, "old-canonical", { cwd: a, frontier: baseline, head: source });
    await save(main, "wiki/user.md", "Concurrent saved user change\n");
    const user = await commit(main, "user", "wiki/user.md");
    await expect(publishCanonical(main, old)).rejects.toThrow("main changed");
    expect(await git(main, "rev-parse", "HEAD")).toBe(user);
    const current = await prepareCanonical(main, "current-canonical", { cwd: a, frontier: baseline, head: source });
    await publishCanonical(main, current);
    await save(a, "wiki/draft.md", "Unsaved local work\n");
    await expect(alignAcceptedTask(a, current)).rejects.toThrow("task changed");
    expect(await readFile(join(a, "wiki/draft.md"), "utf8")).toBe("Unsaved local work\n");
    const newSource = await commit(a, "new-source", "wiki/draft.md");
    await expect(alignAcceptedTask(a, current)).rejects.toThrow("task changed");
    // The newer local commit must first enter canonical main; aligning to the older result would discard it.
    const complete = await prepareCanonical(main, "complete-canonical", { cwd: a, frontier: source, head: newSource });
    await publishCanonical(main, complete);
    await alignAcceptedTask(a, complete);
    expect(await tree(a)).toBe(await tree(main));
    expect(await readFile(join(main, "wiki/draft.md"), "utf8")).toBe("Unsaved local work\n");
  });

  it("preserves a rename plus its later edit through one canonical rename/delete resolution", async () => {
    const { main, a, baseline } = await fixture();
    await git(a, "mv", "wiki/note.md", "wiki/renamed.md");
    await commit(a, "rename", "wiki");
    await save(a, "wiki/renamed.md", "Original\nLater task detail\n");
    const edited = await commit(a, "edit-after-rename", "wiki/renamed.md");
    await git(main, "rm", "wiki/note.md");
    await commit(main, "user-delete");
    const prepared = await prepareCanonical(main, "rename-canonical", { cwd: a, frontier: baseline, head: edited }, async cwd => {
      await git(cwd, "rm", "--ignore-unmatch", "wiki/note.md");
      await save(cwd, "wiki/renamed.md", "Original\n");
    });
    await publishCanonical(main, prepared);
    await alignAcceptedTask(a, prepared);
    expect(await tree(a)).toBe(await tree(main));
    expect(await readFile(join(main, "wiki/renamed.md"), "utf8")).toBe("Original\nLater task detail\n");
    expect(await git(a, "log", "--format=%B")).toContain("Folio-Change-Id: edit-after-rename");
  });

  it("exports only committed paths and retains unrelated Task drafts when alignment must wait", async () => {
    const { main, a, baseline } = await fixture();
    await save(a, "wiki/selected.md", "Explicitly saved\n");
    const head = await commit(a, "selected-file", "wiki/selected.md");
    await save(a, "wiki/draft.md", "Not selected for saving\n");
    const prepared = await prepareCanonical(main, "selected-canonical", { cwd: a, frontier: baseline, head });
    await publishCanonical(main, prepared);
    expect(await readFile(join(main, "wiki/selected.md"), "utf8")).toBe("Explicitly saved\n");
    await expect(readFile(join(main, "wiki/draft.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(alignAcceptedTask(a, prepared)).rejects.toThrow("task changed");
    expect(await readFile(join(a, "wiki/draft.md"), "utf8")).toBe("Not selected for saving\n");
    expect(await git(a, "rev-parse", "HEAD")).toBe(head);
  });

  it("leaves colliding raw inputs intact outside main instead of resolving their text through AI", async () => {
    const { main, a, baseline } = await fixture();
    const path = "raws/lark-im/2026-09-10/source.json";
    await save(main, path, '{"source":"user"}\n');
    await commit(main, "user-raw", path);
    const before = await git(main, "rev-parse", "HEAD");
    await save(a, path, '{"source":"task"}\n');
    const head = await commit(a, "task-raw", path);
    await expect(prepareCanonical(main, "raw-canonical", { cwd: a, frontier: baseline, head }, async cwd => {
      expect(await git(cwd, "diff", "--name-only", "--diff-filter=U")).toBe(path);
      throw new Error("raw collision requires a lossless policy");
    })).rejects.toThrow("raw collision");
    expect(await git(main, "rev-parse", "HEAD")).toBe(before);
    expect(await git(main, "status", "--porcelain")).toBe("");
    expect(await readFile(join(main, path), "utf8")).toBe('{"source":"user"}\n');
    expect(await readFile(join(a, path), "utf8")).toBe('{"source":"task"}\n');
  });

  it("protects unsaved main content when a task modifies the same file", async () => {
    const { main, a } = await fixture();
    await save(a, "wiki/note.md", "Task change\n");
    const sha = await commit(a, "task", "wiki/note.md");
    await save(main, "wiki/note.md", "Unsaved user change\n");
    const before = await git(main, "rev-parse", "HEAD");
    await expect(git(main, "cherry-pick", sha)).rejects.toBeDefined();
    expect(await readFile(join(main, "wiki/note.md"), "utf8")).toBe("Unsaved user change\n");
    expect(await git(main, "rev-parse", "HEAD")).toBe(before);
  });

  it("shows Git allows unrelated dirty content, requiring a stricter Folio preflight", async () => {
    const { main, a } = await fixture();
    await save(a, "wiki/a.md", "Task change\n");
    const sha = await commit(a, "task", "wiki/a.md");
    await save(main, "wiki/note.md", "Unsaved user change\n");
    await git(main, "cherry-pick", sha);
    expect(await git(main, "status", "--porcelain")).toContain("wiki/note.md");
    expect(await readFile(join(main, "wiki/note.md"), "utf8")).toBe("Unsaved user change\n");
  });

  it("keeps rename/delete conflict resolution outside main in a coordinator worktree", async () => {
    const { main, a, b } = await fixture();
    await git(a, "mv", "wiki/note.md", "wiki/renamed.md");
    const rename = await commit(a, "rename", "wiki");
    await git(main, "rm", "wiki/note.md");
    await commit(main, "delete");
    await git(b, "merge", "--ff-only", "main");
    const before = await git(main, "rev-parse", "HEAD");
    await expect(git(b, "cherry-pick", rename)).rejects.toBeDefined();
    expect(await git(b, "diff", "--name-only", "--diff-filter=U")).not.toBe("");
    expect(await git(main, "status", "--porcelain")).toBe("");
    expect(await git(main, "rev-parse", "HEAD")).toBe(before);
    await git(b, "cherry-pick", "--abort");
  });

  it("recovers the exact applied SHA from a commit trailer after a lost database receipt", async () => {
    const { main, a } = await fixture();
    await save(a, "wiki/a.md", "Task change\n");
    const sha = await commit(a, "recoverable", "wiki/a.md");
    await git(main, "cherry-pick", sha);
    const applied = await git(main, "rev-parse", "HEAD");
    // Simulate process death before the receipt is persisted; inspect history without repicking.
    const recovered = await git(main, "log", "--format=%H", "--fixed-strings", "--grep=Folio-Change-Id: recoverable");
    expect(recovered).toBe(applied);
    expect(await readFile(join(main, "wiki/a.md"), "utf8")).toBe("Task change\n");
  });
});
