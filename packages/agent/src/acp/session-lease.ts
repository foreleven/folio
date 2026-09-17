import { threadId, isMainThread } from "node:worker_threads";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Schema, Semaphore } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import { nativeAgent, type NativeSessionIdentity } from "./session-backend.js";

const Owner = Schema.Struct({
  lease_key: Schema.String, token: Schema.String, host: Schema.String,
  owner_pid: Schema.Int.check(Schema.isGreaterThan(0)),
  worker_pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
});
const Owners = Schema.Array(Owner);
const gates = new Map<string, Semaphore.Semaphore>();

/** Stable ownership failures contain no paths, native identity or OS diagnostics. */
export class SessionLeaseError extends Schema.TaggedError<SessionLeaseError>()("SessionLeaseError", {
  reason: Schema.Literals(["busy", "unavailable", "worker_running"]),
  message: Schema.String,
}) {}
const failure = (reason: SessionLeaseError["reason"]) => new SessionLeaseError({
  reason, message: reason === "busy" ? "Session is already owned by another execution."
    : reason === "worker_running" ? "Native execution has not exited." : "Session ownership storage is unavailable.",
});

/** Only ESRCH proves death. Permission errors and PID reuse conservatively keep ownership blocked. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error instanceof Error && "code" in error && error.code === "ESRCH"); }
}
const nativeKey = (identity: NativeSessionIdentity): string => JSON.stringify(["native", nativeAgent(identity), identity.nativeSessionId]);

export interface SessionLease {
  /** Adds the native identity and worker PID before any Prompt may be dispatched. */
  readonly bind: (identity: NativeSessionIdentity, workerPid: number) => Promise<void>;
  /** Releases only after backend shutdown; an old owner can never delete another owner's receipt. */
  readonly release: () => Promise<void>;
}

/**
 * Local process ownership, separate from message history and the future Vault domain database.
 * BEGIN IMMEDIATE serializes claims and recovery; there is no heartbeat or stale-time takeover.
 * A dead parent does not permit recovery while its registered native worker still exists.
 */
export class SessionLeaseStore {
  constructor(readonly directory: string) {
    if (!isAbsolute(directory)) throw failure("unavailable");
  }

  /** Opens a short-lived scoped connection. A local semaphore avoids synchronous SQLite busy waits against this same process. */
  async #transaction<A>(body: (sql: SqliteClient.SqliteClient) => Effect.Effect<A, unknown>, requireExistingStore = false): Promise<A> {
    try {
      if (requireExistingStore) {
        const info = await lstat(join(this.directory, "execution-owners.db"));
        if (!info.isFile() || info.isSymbolicLink()) throw failure("unavailable");
      } else await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const directory = await realpath(this.directory);
      let gate = gates.get(directory);
      if (!gate) { gate = Semaphore.makeUnsafe(1); gates.set(directory, gate); }
      return await Effect.runPromise(gate.withPermit(Effect.scoped(Effect.gen(function*() {
        // Concurrent first-time owners must not race a journal-mode change. This small coordination
        // database uses short serialized transactions; leave its existing journal mode unchanged.
        const sql = yield* SqliteClient.make({ filename: join(directory, "execution-owners.db"), disableWAL: true });
        if (requireExistingStore) {
          const table = yield* sql`SELECT name FROM sqlite_master WHERE type='table' AND name='session_owners'`;
          if (table.length !== 1) return yield* failure("unavailable");
        } else yield* sql`CREATE TABLE IF NOT EXISTS session_owners (
          lease_key TEXT PRIMARY KEY, token TEXT NOT NULL, host TEXT NOT NULL,
          owner_pid INTEGER NOT NULL CHECK (owner_pid > 0), worker_pid INTEGER CHECK (worker_pid > 0)
        )`;
        return yield* sql.withTransaction(Effect.gen(function*() {
          const columns = yield* sql<{ name: string }>`PRAGMA table_info(session_owners)`;
          if (!columns.some(column => column.name === "owner_thread_id")) {
            yield* sql`ALTER TABLE session_owners ADD COLUMN owner_thread_id INTEGER NOT NULL DEFAULT 0`;
          }
          return yield* body(sql);
        }));
      }).pipe(Effect.provide(Reactivity.layer), Effect.catchDefect(() => Effect.fail(failure("unavailable")))))));
    } catch (error) { throw error instanceof SessionLeaseError ? error : failure("unavailable"); }
  }

  /**
   * Host-only cleanup after joining a failed Worker thread. A surviving native child still
   * prevents release; the caller must prove thread exit before invoking this operation.
   */
  async releaseExitedThread(exitedThreadId: number): Promise<void> {
    if (!isMainThread || !Number.isSafeInteger(exitedThreadId) || exitedThreadId <= 0) throw failure("unavailable");
    // A Worker can fail to import before it creates the ownership store. Absence
    // then means there is no lease to release; other filesystem failures still fail.
    try { await lstat(join(this.directory, "execution-owners.db")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw failure("unavailable");
    }
    await this.#transaction(sql => Effect.gen(function*() {
      const owners = yield* sql`SELECT * FROM session_owners WHERE owner_pid=${process.pid}
        AND owner_thread_id=${exitedThreadId} AND host=${hostname()}`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Owners)));
      if (owners.some(owner => owner.worker_pid !== null && owner.worker_pid !== process.pid && alive(owner.worker_pid))) {
        return yield* failure("worker_running");
      }
      yield* sql`DELETE FROM session_owners WHERE owner_pid=${process.pid}
        AND owner_thread_id=${exitedThreadId} AND host=${hostname()}`;
    }), true);
  }

  /** Claims both identities before execution. Recovery requires existing ownership evidence; absence is not proof of death. */
  async acquire(sessionId: string, native?: NativeSessionIdentity, options: { readonly requireExistingStore?: boolean } = {}): Promise<SessionLease> {
    const token = randomUUID();
    const host = hostname();
    const keys = [JSON.stringify(["acp", sessionId]), ...(native ? [nativeKey(native)] : [])];
    const store = this;

    /** Reclaims only verified dead local owners, under the same write transaction as the new claim. */
    const claim = Effect.fn("SessionLease.claim")(function*(sql: SqliteClient.SqliteClient, key: string, workerPid: number | null) {
      const rows = yield* sql`SELECT * FROM session_owners WHERE lease_key = ${key}`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Owners)));
      const owner = rows[0];
      if (owner?.token === token) return;
      if (owner && (owner.host !== host || alive(owner.owner_pid) || (owner.worker_pid !== null && alive(owner.worker_pid)))) {
        return yield* failure("busy");
      }
      if (owner) yield* sql`DELETE FROM session_owners WHERE lease_key = ${key} AND token = ${owner.token}`;
      yield* sql`INSERT INTO session_owners (lease_key, token, host, owner_pid, worker_pid, owner_thread_id)
        VALUES (${key}, ${token}, ${host}, ${process.pid}, ${workerPid}, ${threadId})`;
    });
    await this.#transaction((sql) => Effect.gen(function*() {
      for (const key of keys) yield* claim(sql, key, null);
    }), options.requireExistingStore);
    let released = false;
    return {
      bind: async (identity, workerPid) => {
        if (released || !Number.isSafeInteger(workerPid) || workerPid <= 0) throw failure("unavailable");
        await store.#transaction((sql) => Effect.gen(function*() {
          const owners = yield* sql`SELECT * FROM session_owners WHERE token = ${token}`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Owners)));
          if (!owners.length || owners.some((owner) => owner.owner_pid !== process.pid || owner.host !== host)) return yield* failure("unavailable");
          // A receipt belongs to one native execution for its entire lifetime, including repeated bind calls.
          if (owners.some((owner) => (owner.lease_key !== keys[0] && owner.lease_key !== nativeKey(identity))
            || (owner.worker_pid !== null && owner.worker_pid !== workerPid))) return yield* failure("unavailable");
          yield* claim(sql, nativeKey(identity), workerPid);
          yield* sql`UPDATE session_owners SET worker_pid = ${workerPid} WHERE token = ${token}`;
        }), true);
      },
      release: async () => {
        if (released) return;
        await store.#transaction((sql) => Effect.gen(function*() {
          const owners = yield* sql`SELECT * FROM session_owners WHERE token = ${token}`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Owners)));
          if (owners.some((owner) => owner.worker_pid !== null && owner.worker_pid !== process.pid && alive(owner.worker_pid))) {
            return yield* failure("worker_running");
          }
          yield* sql`DELETE FROM session_owners WHERE token = ${token} AND owner_pid = ${process.pid} AND host = ${host}`;
        }), true);
        released = true;
      },
    };
  }
}
