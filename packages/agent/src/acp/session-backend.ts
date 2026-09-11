import type { ContentBlock, SessionConfigOption, SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { Schema } from "effect";
import { PiSessionIdentity } from "../pi/session-storage.js";

export const CodexSessionIdentity = Schema.Struct({
  agent: Schema.Literal("codex"), nativeSessionId: Schema.NonEmptyString,
});
export const NativeSessionIdentity = Schema.Union([PiSessionIdentity, CodexSessionIdentity]);
export type NativeSessionIdentity = typeof NativeSessionIdentity.Type;

/** Existing Pi native headers remain unambiguous because they require the native session file. */
export const nativeAgent = (identity: NativeSessionIdentity): "pi" | "codex" => "agent" in identity ? identity.agent : "pi";

/** Protocol-facing ownership boundary. A backend owns foreground execution and its terminal updates. */
export interface AcpSessionBackend {
  /** Native worker PID; Pi runs in the ACP process, Codex in its scoped child process. */
  readonly processId: number;
  readonly native: () => Promise<NativeSessionIdentity>;
  readonly state: () => Promise<"idle" | "busy" | "closed">;
  readonly config: () => Promise<SessionConfigOption[]>;
  readonly setConfig: (id: string, value: string) => Promise<SessionConfigOption[]>;
  readonly prompt: (text: string, content: ContentBlock[]) => Promise<void>;
  readonly cancel: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface AcpSessionBackendInput {
  readonly sessionId: string;
  readonly cwd: string;
  readonly resume?: NativeSessionIdentity;
  /** Cancels in-flight external process initialization when the ACP client disconnects or shuts down. */
  readonly signal?: AbortSignal;
  /** Resolves after the exact ACP update has been persisted and sent. */
  readonly onUpdate: (update: SessionUpdate) => Promise<void>;
}

export interface AcpSessionBackendFactory {
  readonly agent: "pi" | "codex";
  readonly create: (input: AcpSessionBackendInput) => Promise<AcpSessionBackend>;
}
