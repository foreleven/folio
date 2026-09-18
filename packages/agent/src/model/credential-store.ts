import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { lock } from "proper-lockfile";
import { resolveFolioAgentDirectory, type ResolveAgentDirectoryOptions } from "../config/directory.js";

const API_KEY_FILE_MODE = 0o600;
const AGENT_DIRECTORY_MODE = 0o700;

const ProviderId = Schema.String.check(
  Schema.isMinLength(1, { expected: "providerId must not be empty" }),
  Schema.makeFilter((value) => value === value.trim(), {
    expected: "providerId must not have leading or trailing whitespace",
  }),
);
const ProviderEnvironment = Schema.Record(Schema.String, Schema.String);
const ApiKeyCredentialSchema = Schema.Struct({
  type: Schema.Literal("api_key"),
  key: Schema.optionalKey(Schema.String),
  env: Schema.optionalKey(ProviderEnvironment),
});
const OAuthCredentialSchema = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.Literal("oauth"),
    refresh: Schema.String,
    access: Schema.String,
    expires: Schema.Finite,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const CredentialSchema = Schema.Union([ApiKeyCredentialSchema, OAuthCredentialSchema]);
const CredentialFileSchema = Schema.Record(Schema.String, CredentialSchema);

export const CredentialStoreFailureReason = Schema.Literals([
  "invalid_provider",
  "invalid_credential",
  "invalid_file",
  "permission",
  "locked",
  "io",
]);
export type CredentialStoreFailureReason = typeof CredentialStoreFailureReason.Type;

/** Stable, serializable, secret-free failure exposed across model service boundaries. */
export class CredentialStoreError extends Schema.TaggedError<CredentialStoreError>()(
  "CredentialStoreError",
  {
    reason: CredentialStoreFailureReason,
    message: Schema.String,
  },
) {}

export interface SecureCredentialStoreOptions {
  readonly authPath?: string;
  readonly directory?: ResolveAgentDirectoryOptions;
}

const failureMessage: Record<CredentialStoreFailureReason, string> = {
  invalid_provider: "Credential provider id is invalid.",
  invalid_credential: "Credential data is invalid.",
  invalid_file: "Credential storage is invalid.",
  permission: "Credential storage permissions are not secure.",
  locked: "Credential storage is busy.",
  io: "Credential storage is unavailable.",
};

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;

const storageError = (reason: CredentialStoreFailureReason): CredentialStoreError =>
  new CredentialStoreError({ reason, message: failureMessage[reason] });

const mapStorageError = (error: unknown): CredentialStoreError => {
  if (error instanceof CredentialStoreError) return error;
  const code = errorCode(error);
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return storageError("permission");
  return storageError("io");
};

const runStorageOperation = async <T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  try {
    signal?.throwIfAborted();
    const result = await operation();
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    if (signal?.aborted) throw error;
    throw mapStorageError(error);
  }
};

const decodeProviderId = (providerId: string): string => {
  try {
    return Schema.decodeUnknownSync(ProviderId)(providerId);
  } catch {
    throw storageError("invalid_provider");
  }
};

const decodeCredential = (credential: Credential): Credential => {
  try {
    return Schema.decodeUnknownSync(CredentialSchema)(credential, {
      onExcessProperty: "error",
      errors: "all",
    }) as Credential;
  } catch {
    throw storageError("invalid_credential");
  }
};

const parseCredentialFile = (content: string): Record<string, Credential> => {
  try {
    const decoded = Schema.decodeUnknownSync(CredentialFileSchema)(JSON.parse(content), {
      onExcessProperty: "error",
      errors: "all",
    }) as Record<string, Credential>;
    for (const providerId of Object.keys(decoded)) decodeProviderId(providerId);
    return decoded;
  } catch {
    throw storageError("invalid_file");
  }
};

const credentialMetadata = (data: Record<string, Credential>): readonly CredentialInfo[] =>
  Object.entries(data).map(([providerId, credential]) => ({ providerId, type: credential.type }));

/**
 * Pi-compatible file credential store owned by Folio. It keeps secrets outside Effect errors/logs,
 * uses a same-directory atomic replacement, and serializes writers across processes with a lock file.
 */
export class SecureCredentialStore implements CredentialStore {
  readonly authPath: string;
  readonly directory: string;
  #chain: Promise<void> = Promise.resolve();

  constructor(options: SecureCredentialStoreOptions = {}) {
    this.authPath = options.authPath ?? join(resolveFolioAgentDirectory(options.directory), "auth.json");
    this.directory = dirname(this.authPath);
  }

  async #ensureStorage(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: AGENT_DIRECTORY_MODE });
    const directoryInfo = await lstat(this.directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw storageError("permission");
    await chmod(this.directory, AGENT_DIRECTORY_MODE);
    try {
      const existing = await lstat(this.authPath);
      if (!existing.isFile() || existing.isSymbolicLink()) throw storageError("permission");
    } catch (error) {
      if (error instanceof CredentialStoreError) throw error;
      if (errorCode(error) !== "ENOENT") throw error;
      await writeFile(this.authPath, "{}\n", { encoding: "utf8", mode: API_KEY_FILE_MODE, flag: "wx" })
        .catch((writeError: unknown) => {
          if (errorCode(writeError) !== "EEXIST") throw writeError;
        });
    }
    const authInfo = await lstat(this.authPath);
    if (!authInfo.isFile() || authInfo.isSymbolicLink()) throw storageError("permission");
    await chmod(this.authPath, API_KEY_FILE_MODE);
  }

  async #acquireLock(signal?: AbortSignal): Promise<() => Promise<void>> {
    signal?.throwIfAborted();
    try {
      const release = await lock(this.authPath, {
        realpath: false,
        stale: 10_000,
        update: 5_000,
        retries: { retries: 20, factor: 1.2, minTimeout: 10, maxTimeout: 100 },
      });
      if (signal?.aborted) {
        await release();
        signal.throwIfAborted();
      }
      return release;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (errorCode(error) === "ELOCKED") throw storageError("locked");
      throw mapStorageError(error);
    }
  }

  async #readFile(): Promise<Record<string, Credential>> {
    await this.#ensureStorage();
    const info = await lstat(this.authPath);
    if (!info.isFile() || info.isSymbolicLink()) throw storageError("permission");
    if ((info.mode & 0o077) !== 0) {
      await chmod(this.authPath, API_KEY_FILE_MODE);
    }
    return parseCredentialFile(await readFile(this.authPath, "utf8"));
  }

  async #writeFile(data: Record<string, Credential>): Promise<void> {
    const temporary = join(this.directory, `.auth.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, {
        encoding: "utf8",
        mode: API_KEY_FILE_MODE,
        flag: "wx",
      });
      await chmod(temporary, API_KEY_FILE_MODE);
      await rename(temporary, this.authPath);
      await chmod(this.authPath, API_KEY_FILE_MODE);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#chain;
    const current = previous.catch(() => undefined).then(operation);
    this.#chain = current.then(() => undefined, () => undefined);
    return current;
  }

  read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    const id = decodeProviderId(providerId);
    return runStorageOperation(async () => {
      const data = await this.#readFile();
      const credential = Object.hasOwn(data, id) ? data[id] : undefined;
      return credential === undefined ? undefined : structuredClone(credential);
    }, options?.signal);
  }

  list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    return runStorageOperation(async () => credentialMetadata(await this.#readFile()), options?.signal);
  }

  /**
   * Copies a local Pi auth file once, without changing its contents or permissions. Existing Folio
   * credentials win; the completion marker prevents deleted credentials being resurrected on restart.
   * Missing files are harmless and can be discovered on a later launch. Failures never contain secrets.
   */
  importPiAuth(sourcePath: string): Promise<void> {
    return this.#exclusive(() => runStorageOperation(async () => {
      const marker = join(this.directory, ".pi-auth-imported");
      try {
        await lstat(marker);
        return;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      let content: string;
      try {
        content = await readFile(sourcePath, "utf8");
      } catch (error) {
        if (errorCode(error) === "ENOENT") return;
        throw error;
      }
      const imported = parseCredentialFile(content);
      await this.#ensureStorage();
      const release = await this.#acquireLock();
      try {
        // Recheck under the same cross-process lock used by all credential writers.
        try {
          await lstat(marker);
          return;
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
        const current = await this.#readFile();
        await this.#writeFile({ ...imported, ...current });
        await writeFile(marker, "1\n", { mode: API_KEY_FILE_MODE });
      } finally {
        await release();
      }
    }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.#exclusive(async () => {
      const id = decodeProviderId(providerId);
      await runStorageOperation(() => this.#ensureStorage(), options?.signal);
      // Receive ownership directly: a post-acquisition abort check outside try/finally
      // could discard the release function and leave the cross-process lock held.
      const release = await this.#acquireLock(options?.signal);
      try {
        const data = await runStorageOperation(() => this.#readFile(), options?.signal);
        // Provider IDs are data, including names inherited by ordinary JavaScript objects.
        const current = Object.hasOwn(data, id) ? data[id] : undefined;
        const next = await fn(current === undefined ? undefined : structuredClone(current));
        options?.signal?.throwIfAborted();
        if (next === undefined) return current === undefined ? undefined : structuredClone(current);
        const checked = decodeCredential(next);
        await runStorageOperation(() => this.#writeFile({ ...data, [id]: checked }), options?.signal);
        return structuredClone(checked);
      } finally {
        await release();
      }
    });
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.#exclusive(async () => {
      const id = decodeProviderId(providerId);
      await runStorageOperation(() => this.#ensureStorage(), options?.signal);
      const release = await this.#acquireLock(options?.signal);
      try {
        const data = await runStorageOperation(() => this.#readFile(), options?.signal);
        if (!Object.hasOwn(data, id)) return;
        const { [id]: _removed, ...remaining } = data;
        await runStorageOperation(() => this.#writeFile(remaining), options?.signal);
      } finally {
        await release();
      }
    });
  }
}

export interface CredentialStoreView {
  readonly providerId: string;
  readonly type: Credential["type"];
}

export class FolioCredentialStore extends Context.Service<FolioCredentialStore, {
  readonly authPath: string;
  readonly store: CredentialStore;
  readonly list: Effect.Effect<readonly CredentialStoreView[], CredentialStoreError>;
  readonly setApiKey: (
    providerId: string,
    apiKey: Redacted.Redacted<string>,
  ) => Effect.Effect<void, CredentialStoreError>;
  readonly delete: (providerId: string) => Effect.Effect<void, CredentialStoreError>;
}>()("@folio/agent/model/FolioCredentialStore") {
  static layer(options: SecureCredentialStoreOptions = {}) {
    return Layer.effect(FolioCredentialStore, Effect.sync(() => {
      const store = new SecureCredentialStore(options);
      const list = Effect.tryPromise({
        try: () => store.list(),
        catch: mapStorageError,
      });
      const setApiKey = Effect.fn("FolioCredentialStore.setApiKey")(function*(
        providerId: string,
        apiKey: Redacted.Redacted<string>,
      ) {
        const value = Redacted.value(apiKey);
        if (value.length === 0) return yield* storageError("invalid_credential");
        yield* Effect.tryPromise({
          try: () => store.modify(providerId, async () => ({ type: "api_key", key: value })),
          catch: mapStorageError,
        });
      });
      const remove = Effect.fn("FolioCredentialStore.delete")(function*(providerId: string) {
        yield* Effect.tryPromise({
          try: () => store.delete(providerId),
          catch: mapStorageError,
        });
      });
      return FolioCredentialStore.of({
        authPath: store.authPath,
        store,
        list,
        setApiKey,
        delete: remove,
      });
    }));
  }
}
