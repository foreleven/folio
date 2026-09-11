import { Effect, Schema } from "effect";
import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveSessionSkillPaths } from "../config/session-skills.js";
import type { openCodexConnection } from "./connection.js";

const ListedSkills = Schema.Struct({ data: Schema.Array(Schema.Struct({
  cwd: Schema.String,
  skills: Schema.Array(Schema.Struct({ name: Schema.NonEmptyString, path: Schema.String, enabled: Schema.Boolean })),
  errors: Schema.Array(Schema.Struct({ path: Schema.String, message: Schema.String })),
})) });

/** Failures omit native filesystem diagnostics and unrelated user Skill catalog contents. */
export class CodexSkillsError extends Schema.TaggedError<CodexSkillsError>()("CodexSkillsError", { message: Schema.String }) {}
const failure = () => new CodexSkillsError({ message: "Selected Codex skills could not be loaded." });

/**
 * Replaces only this app-server's extra roots, then verifies each explicit file was loaded and
 * enabled. Never calls skills/config/write, which would change the user's persistent settings.
 * Unselected discovery results are not forwarded into turn inputs or Folio messages.
 */
export const loadCodexSkills = Effect.fn("CodexSkills.load")(function*(
  connection: Pick<Effect.Success<ReturnType<typeof openCodexConnection>>, 'request'>, cwd: string, selected: readonly string[],
) {
  if (!selected.length) return [];
  const paths = yield* Effect.tryPromise(async () => [...new Set(await Promise.all(
    (await resolveSessionSkillPaths(JSON.stringify(selected))).map(path => realpath(path)),
  ))]);
  yield* connection.request("skills/extraRoots/set", { extraRoots: [...new Set(paths.map(dirname))] });
  const listed = yield* connection.request("skills/list", { cwds: [cwd], forceReload: true }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ListedSkills)),
  );
  if (listed.data.length !== 1 || (yield* Effect.tryPromise(() => realpath(listed.data[0]!.cwd))) !==
    (yield* Effect.tryPromise(() => realpath(cwd)))) return yield* failure();
  const result: { type: "skill"; name: string; path: string }[] = [];
  for (const path of paths) {
    const matching = listed.data[0]!.skills.filter(skill => skill.path === path);
    if (matching.length !== 1 || !matching[0]!.enabled || result.some(skill => skill.name === matching[0]!.name)) return yield* failure();
    result.push({ type: "skill", name: matching[0]!.name, path });
  }
  return result;
}, Effect.mapError(failure));
