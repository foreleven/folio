/** Native bytes may be supervised by the host while SDK execution stays in a Worker. */
export interface CodexProcessTransport {
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<void>;
  /** Must wait for OS exit/reaping, not merely signal delivery. */
  readonly close: () => Promise<void>;
}
