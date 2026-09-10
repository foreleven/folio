import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

export type PiSessionLifecycle = Pick<AgentSession, "abort" | "dispose" | "isIdle">;

/**
 * Owns a Pi session for an Effect scope. Active work is aborted before the
 * session is disposed so cancellation cannot leak beyond the scope.
 */
export const acquirePiSession = <E>(
  acquire: Effect.Effect<PiSessionLifecycle, E>,
): Effect.Effect<PiSessionLifecycle, E, import("effect").Scope.Scope> =>
  Effect.acquireRelease(acquire, (session) =>
    Effect.promise(async () => {
      if (!session.isIdle) {
        await session.abort();
      }
      session.dispose();
    }),
  );
