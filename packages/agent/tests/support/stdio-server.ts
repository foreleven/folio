import { client, methods, ndJsonStream, PROTOCOL_VERSION, type ClientContext, type SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";

/** Starts the built production CLI for one connection, then waits for its full process shutdown. */
export async function withServer<A>(directory: string, run: (context: ClientContext, updates: SessionUpdate[]) => Promise<A>, options: { args?: string[]; env?: NodeJS.ProcessEnv } = {}): Promise<A> {
  const child = spawn(process.execPath, [resolve("dist/cli.js"), ...(options.args ?? [])], {
    env: { ...process.env, FOLIO_SESSION_SKILL_PATHS: "[]", FOLIO_SESSION_MODEL_PROFILE: "", FOLIO_SESSION_RUNTIME_DIR: "", FOLIO_CONFIG_DIR: directory, FOLIO_AGENT_DIR: join(directory, "agent"), FOLIO_SESSION_STORAGE_DIR: join(directory, "agent"), ...options.env }, stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const exited = new Promise<void>((resolveExit, reject) => {
    child.once("close", () => resolveExit());
    child.once("error", reject);
  });
  try {
    const updates: SessionUpdate[] = [];
    return await client().onNotification(methods.client.session.update, ({ params }) => { updates.push(params.update); }).connectWith(
      ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>),
      async (context) => {
        await context.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, info: { name: "folio-resume-test", version: "1" }, capabilities: {} });
        return run(context, updates);
      },
    );
  } finally {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    await exited;
    clearTimeout(timer);
  }
}
