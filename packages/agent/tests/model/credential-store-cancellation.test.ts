import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import { expect, it, vi } from "vitest";
import { SecureCredentialStore } from "../../src/model/credential-store.js";

vi.mock("proper-lockfile", () => ({ lock: vi.fn() }));

it.each(["modify", "delete"] as const)("releases a credential lock when %s is cancelled during ownership handoff", async (method) => {
  const directory = await mkdtemp(join(tmpdir(), "folio-credential-cancel-"));
  try {
    const store = new SecureCredentialStore({ authPath: join(directory, "auth.json") });
    const controller = new AbortController();
    const cancelled = new Error("cancelled during acquisition");
    const release = vi.fn(async () => undefined);
    let acquired!: (release: () => Promise<void>) => void;
    let entered!: () => void;
    const acquisition = new Promise<() => Promise<void>>(resolve => { acquired = resolve; });
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(lock).mockImplementationOnce(() => {
      entered();
      return acquisition;
    });
    const update = vi.fn(async () => ({ type: "api_key" as const, key: "must-not-write" }));
    const operation = method === "modify"
      ? store.modify("provider", update, { signal: controller.signal })
      : store.delete("provider", { signal: controller.signal });
    await waiting;
    // The lock owner resumes first; cancellation arrives before its caller receives ownership.
    acquired(release);
    queueMicrotask(() => controller.abort(cancelled));
    await expect(operation).rejects.toBe(cancelled);
    expect(release).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect(await store.list()).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
