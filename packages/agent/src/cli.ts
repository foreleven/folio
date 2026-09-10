#!/usr/bin/env node
import { ndJsonStream } from "@agentclientprotocol/sdk/experimental/v2";
import { Effect } from "effect";
import { Readable, Writable } from "node:stream";
import { createFolioAgentApp } from "./acp/server.js";
import {
  AgentConfigLoadError,
  loadFolioAgentConfig,
  type FolioAgentConfigSnapshot,
} from "./config/loader.js";
import { makeFolioAgentRuntimeComposition } from "./runtime/composition.js";

let snapshot: FolioAgentConfigSnapshot | undefined;
try {
  snapshot = await Effect.runPromise(loadFolioAgentConfig());
} catch (error) {
  const message = error instanceof AgentConfigLoadError
    ? error.message
    : "Agent configuration is unavailable.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

if (snapshot !== undefined) {
  if (snapshot.defaultProfile !== undefined) {
    process.stderr.write(
      `default model loaded ${snapshot.defaultProfile.provider.providerId}/${snapshot.defaultProfile.modelId}\n`,
    );
  }

  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const composition = makeFolioAgentRuntimeComposition(snapshot);
  const app = createFolioAgentApp({ sessionFactory: composition.sessionFactory });
  const connection = app.connect(ndJsonStream(output, input));

  const close = (): void => connection.close();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);

  try {
    await connection.closed;
  } finally {
    process.removeListener("SIGINT", close);
    process.removeListener("SIGTERM", close);
    try {
      await app.shutdown();
    } finally {
      await composition.shutdown();
    }
  }
}
