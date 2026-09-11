import { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { Schema } from "effect";
import { constants } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { SessionLeaseStore } from "./session-lease.js";
import { NativeSessionIdentity } from "./session-backend.js";

const SessionId = Schema.String.check(Schema.makeFilter((id) => /^[a-zA-Z0-9_-]{1,128}$/.test(id)));
const Header = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: SessionId,
  cwd: Schema.String,
  native: NativeSessionIdentity,
  createdAt: Schema.String,
});
export type ArchivedSessionHeader = typeof Header.Type;

// Public ACP guards validate payloads, despite accepting the union as their TypeScript argument.
const Update = Schema.declare<SessionUpdate>((input): input is SessionUpdate =>
  Object.values(SessionUpdate).some((guard) => guard(input as SessionUpdate)));
const Record = Schema.Struct({ update: Update, timestamp: Schema.String });

/** Protocol archive failures never expose persisted prompt/output contents. */
export class SessionArchiveError extends Schema.TaggedError<SessionArchiveError>()("SessionArchiveError", {
  message: Schema.String,
}) {}
const failure = () => new SessionArchiveError({ message: "The ACP session archive is unavailable or invalid." });

/**
 * Agent ACP adapter-owned replay storage, separate from the harness's future Vault event database.
 * Headers are published atomically; updates are appended and flushed before client notification.
 * A truncated/corrupt log fails explicitly rather than replaying or appending ambiguous history.
 */
export class SessionArchive {
  readonly #pending = new Map<string, Promise<void>>();

  readonly leases: SessionLeaseStore;

  constructor(readonly directory: string) {
    if (!isAbsolute(directory)) throw failure();
    this.leases = new SessionLeaseStore(directory);
  }

  /** Restricts protocol IDs to a filename component before any filesystem access. */
  #path(sessionId: string): string {
    try { return join(this.directory, Schema.decodeUnknownSync(SessionId)(sessionId)); }
    catch { throw failure(); }
  }

  /** Creates one header and an empty replay log without overwriting an existing session. */
  async create(header: ArchivedSessionHeader): Promise<void> {
    const target = this.#path(header.sessionId);
    const temporary = join(this.directory, `.creating-${randomUUID()}`);
    try {
      Schema.decodeUnknownSync(Header)(header, { onExcessProperty: "error" });
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await mkdir(temporary, { mode: 0o700 });
      await writeFile(join(temporary, "header.json"), JSON.stringify(header), { mode: 0o600, flag: "wx" });
      await writeFile(join(temporary, "updates.jsonl"), "", { mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } catch { throw failure(); }
    finally { await rm(temporary, { recursive: true, force: true }).catch(() => undefined); }
  }

  /** Lists persisted sessions even after close/restart, without reading their replay bodies. */
  async list(): Promise<readonly (ArchivedSessionHeader & { updatedAt: string })[]> {
    try {
      const files = await readdir(this.directory, { withFileTypes: true }).catch((error: unknown) => {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
        throw error;
      });
      return await Promise.all(files.filter((file) => file.isDirectory() && !file.name.startsWith(".")).map(async (file) => {
        const path = this.#path(file.name);
        const header = Schema.decodeUnknownSync(Header)(JSON.parse(await readFile(join(path, "header.json"), "utf8")), { onExcessProperty: "error" });
        if (header.sessionId !== file.name) throw failure();
        return { ...header, updatedAt: (await stat(join(path, "updates.jsonl"))).mtime.toISOString() };
      }));
    } catch { throw failure(); }
  }

  /** Reads immutable native identity without loading a possibly live replay log. */
  async readHeader(sessionId: string): Promise<ArchivedSessionHeader> {
    try {
      const header = Schema.decodeUnknownSync(Header)(JSON.parse(await readFile(join(this.#path(sessionId), "header.json"), "utf8")), { onExcessProperty: "error" });
      if (header.sessionId !== sessionId) throw failure();
      return header;
    } catch { throw failure(); }
  }

  /** Loads an exact replay sequence; missing or truncated files cannot be treated as empty history. */
  async read(sessionId: string): Promise<{ header: ArchivedSessionHeader; history: SessionUpdate[] }> {
    try {
      await this.#pending.get(sessionId);
      const path = this.#path(sessionId);
      const header = await this.readHeader(sessionId);
      const text = await readFile(join(path, "updates.jsonl"), "utf8");
      if (text !== "" && !text.endsWith("\n")) throw failure();
      const history = text === "" ? [] : text.slice(0, -1).split("\n").map((line) =>
        Schema.decodeUnknownSync(Record)(JSON.parse(line)).update);
      return { header, history };
    } catch { throw failure(); }
  }

  /** Orders each session's writes; a failed write poisons the queue until explicit recovery. */
  append(sessionId: string, update: SessionUpdate): Promise<void> {
    const write = (this.#pending.get(sessionId) ?? Promise.resolve()).then(async () => {
      try {
        Schema.decodeUnknownSync(Update)(update);
        const handle = await open(join(this.#path(sessionId), "updates.jsonl"), constants.O_WRONLY | constants.O_APPEND);
        try {
          await handle.appendFile(`${JSON.stringify({ update, timestamp: new Date().toISOString() })}\n`, "utf8");
          await handle.sync();
        } finally { await handle.close(); }
      } catch { throw failure(); }
    });
    this.#pending.set(sessionId, write);
    return write;
  }
}
