import type { Credential } from "@earendil-works/pi-ai";
import { mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Redacted } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  CredentialStoreError,
  FolioCredentialStore,
  SecureCredentialStore,
} from "../../src/model/index.js";

const temporaryDirectories: string[] = [];

const makeStore = async () => {
  const directory = await mkdtemp(join(tmpdir(), "folio-credential-store-"));
  temporaryDirectories.push(directory);
  const authPath = join(directory, "agent", "auth.json");
  return { directory, authPath, store: new SecureCredentialStore({ authPath }) };
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true }));
  }));
});

describe("SecureCredentialStore", () => {
  it.each(["constructor", "toString", "__proto__"])("treats %s as a literal provider identifier", async (providerId) => {
    const { authPath, store } = await makeStore();
    await expect(store.read(providerId)).resolves.toBeUndefined();
    await store.modify(providerId, async (current) => {
      expect(current).toBeUndefined();
      return { type: "api_key", key: "provider-secret" };
    });
    const reopened = new SecureCredentialStore({ authPath });
    expect(await reopened.read(providerId)).toEqual({ type: "api_key", key: "provider-secret" });
    expect(await reopened.list()).toEqual([{ providerId, type: "api_key" }]);
    await reopened.delete(providerId);
    expect(await reopened.read(providerId)).toBeUndefined();
    expect(await reopened.list()).toEqual([]);
  });

  it("imports Pi API key and OAuth providers once, preserving Folio credentials and the source file", async () => {
    const { directory, store } = await makeStore();
    const source = join(directory, "pi-auth.json");
    const oauth = { type: "oauth", refresh: "private-refresh", access: "private-access", expires: 12345 };
    const original = JSON.stringify({ anthropic: { type: "api_key", key: "pi-key" }, openai: oauth });
    await writeFile(source, original, { mode: 0o644 });
    await store.modify("anthropic", async () => ({ type: "api_key", key: "folio-key" }));
    await store.importPiAuth(source);
    expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "folio-key" });
    expect(await store.read("openai")).toEqual(oauth);
    expect(await readFile(source, "utf8")).toBe(original);
    expect((await stat(source)).mode & 0o777).toBe(0o644);
    expect(JSON.stringify(await store.list())).not.toContain("private-");
    await store.delete("openai");
    await new SecureCredentialStore({ authPath: store.authPath }).importPiAuth(source);
    expect(await store.read("openai")).toBeUndefined();
  });

  it("allows later discovery of a missing Pi file and rejects malformed input without partial imports", async () => {
    const { directory, store } = await makeStore();
    const source = join(directory, "pi-auth.json");
    await store.importPiAuth(source);
    await writeFile(source, JSON.stringify({ anthropic: { type: "api_key", key: "secret" }, bad: { type: "unknown", key: "private" } }));
    await expect(store.importPiAuth(source)).rejects.toMatchObject({ reason: "invalid_file" });
    expect(await store.list()).toEqual([]);
    await writeFile(source, JSON.stringify({ anthropic: { type: "api_key", key: "secret" } }));
    await store.importPiAuth(source);
    expect(await store.list()).toEqual([{ providerId: "anthropic", type: "api_key" }]);
  });

  it("implements Pi read/modify/list/delete without exposing secret metadata", async () => {
    const { authPath, store } = await makeStore();
    const credential: Credential = { type: "api_key", key: "credential-secret" };

    await expect(store.read("anthropic")).resolves.toBeUndefined();
    await expect(store.modify("anthropic", async () => credential)).resolves.toEqual(credential);
    await expect(store.read("anthropic")).resolves.toEqual(credential);
    await expect(store.list()).resolves.toEqual([{ providerId: "anthropic", type: "api_key" }]);

    const metadata = JSON.stringify(await store.list());
    expect(metadata).not.toContain("credential-secret");
    expect(await readFile(authPath, "utf8")).toContain("credential-secret");

    await store.delete("anthropic");
    await expect(store.read("anthropic")).resolves.toBeUndefined();
  });

  it("enforces 0700 directory and repairs auth.json to 0600", async () => {
    const { authPath, store } = await makeStore();
    await store.modify("anthropic", async () => ({ type: "api_key", key: "credential-secret" }));

    expect((await stat(store.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);

    await import("node:fs/promises").then(({ chmod }) => chmod(authPath, 0o644));
    await expect(store.read("anthropic")).resolves.toEqual({ type: "api_key", key: "credential-secret" });
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
  });

  it("rejects a symlink auth path without reading or chmodding its target", async () => {
    const { directory, authPath, store } = await makeStore();
    await import("node:fs/promises").then(({ mkdir }) => mkdir(store.directory, { recursive: true }));
    const target = join(directory, "outside.json");
    await writeFile(target, JSON.stringify({ anthropic: { type: "api_key", key: "outside-secret" } }), { mode: 0o644 });
    await symlink(target, authPath);

    await expect(store.read("anthropic"))
      .rejects.toMatchObject({ _tag: "CredentialStoreError", reason: "permission" });
    expect((await stat(target)).mode & 0o777).toBe(0o644);
  });

  it("serializes cross-instance read-modify-write and preserves every update", async () => {
    const { authPath } = await makeStore();
    const first = new SecureCredentialStore({ authPath });
    const second = new SecureCredentialStore({ authPath });
    await first.modify("anthropic", async () => ({ type: "api_key", key: "" }));

    const append = (store: SecureCredentialStore, suffix: string) => store.modify("anthropic", async (current) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      const key = current?.type === "api_key" ? current.key ?? "" : "";
      return { type: "api_key", key: `${key}${suffix}` };
    });

    await Promise.all([append(first, "a"), append(second, "b")]);
    const final = await first.read("anthropic");
    expect(final?.type).toBe("api_key");
    if (final?.type === "api_key") expect([...final.key ?? ""].sort()).toEqual(["a", "b"]);
  });

  it("rejects malformed provider/credential/file data with stable secret-free errors", async () => {
    const { authPath, store } = await makeStore();

    await expect(store.modify(" anthropic", async () => ({ type: "api_key", key: "credential-secret" })))
      .rejects.toMatchObject({ _tag: "CredentialStoreError", reason: "invalid_provider" });
    await expect(store.modify("anthropic", async () => ({ type: "api_key", key: "credential-secret", extra: true } as never)))
      .rejects.toMatchObject({ _tag: "CredentialStoreError", reason: "invalid_credential" });

    await store.list();
    await writeFile(authPath, JSON.stringify({
      anthropic: { type: "api_key", key: "leak-this-secret", extra: true },
    }), { mode: 0o600 });
    const failure = await store.read("anthropic").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CredentialStoreError);
    expect(failure).toMatchObject({ reason: "invalid_file", message: "Credential storage is invalid." });
    expect(String(failure)).not.toContain("leak-this-secret");
    expect(JSON.stringify(failure)).not.toContain("leak-this-secret");
  });

  it("propagates modify callback failures unchanged and leaves storage untouched", async () => {
    const { store } = await makeStore();
    await store.modify("anthropic", async () => ({ type: "api_key", key: "original-secret" }));
    const callbackFailure = new Error("provider refresh failed");

    await expect(store.modify("anthropic", async () => { throw callbackFailure; })).rejects.toBe(callbackFailure);
    await expect(store.read("anthropic")).resolves.toEqual({ type: "api_key", key: "original-secret" });
  });

  it("honors an already-aborted operation without changing storage", async () => {
    const { store } = await makeStore();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await expect(store.modify("anthropic", async () => ({ type: "api_key", key: "not-written" }), {
      signal: controller.signal,
    })).rejects.toThrow("cancelled");
    await expect(store.read("anthropic")).resolves.toBeUndefined();
  });
});

describe("FolioCredentialStore", () => {
  it("accepts Redacted API keys and exposes only a metadata view", async () => {
    const { authPath } = await makeStore();
    const program = Effect.gen(function*() {
      const credentials = yield* FolioCredentialStore;
      yield* credentials.setApiKey("anthropic", Redacted.make("effect-secret"));
      return yield* credentials.list;
    }).pipe(Effect.provide(FolioCredentialStore.layer({ authPath })));

    const view = await Effect.runPromise(program);
    expect(view).toEqual([{ providerId: "anthropic", type: "api_key" }]);
    expect(JSON.stringify(view)).not.toContain("effect-secret");
  });

  it("rejects empty API keys without embedding the value in the error", async () => {
    const { authPath } = await makeStore();
    const program = Effect.gen(function*() {
      const credentials = yield* FolioCredentialStore;
      yield* credentials.setApiKey("anthropic", Redacted.make(""));
    }).pipe(Effect.provide(FolioCredentialStore.layer({ authPath })));

    const failure = await Effect.runPromiseExit(program);
    const serialized = JSON.stringify(failure);
    expect(serialized).toContain("invalid_credential");
    expect(serialized).not.toContain("apiKey");
  });
});
