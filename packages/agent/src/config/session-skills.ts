import { Schema } from "effect";
import { stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";

const SkillPaths = Schema.fromJsonString(Schema.Array(
  Schema.NonEmptyString.check(Schema.makeFilter(isAbsolute)),
));

/**
 * Reads only explicitly mounted Skill entrypoints. A missing mount fails startup instead of
 * allowing Pi's permissive discovery to silently start a Session without its selected resources.
 * This validates availability, not sandboxing or immutable resource content.
 */
export async function resolveSessionSkillPaths(value: string | undefined): Promise<readonly string[]> {
  if (!value) return [];
  try {
    const paths = Schema.decodeUnknownSync(SkillPaths)(value);
    const result: string[] = [];
    for (const path of paths) {
      const info = await stat(path);
      const entrypoint = info.isDirectory() ? join(path, "SKILL.md") : path;
      if (basename(entrypoint) !== "SKILL.md" || !(await stat(entrypoint)).isFile()) throw new Error();
      if (!result.includes(entrypoint)) result.push(entrypoint);
    }
    return result;
  } catch {
    // Parse/filesystem diagnostics may contain private host paths; do not preserve the cause.
    throw new Error("Session skills are unavailable.");
  }
}
