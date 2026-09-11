import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveSessionSkillPaths } from "../src/config/session-skills.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("normalizes explicit directories and entrypoints without discovering neighboring Skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "folio-skills-"));
  roots.push(root);
  const selected = join(root, "selected skill");
  await mkdir(selected);
  await writeFile(join(selected, "SKILL.md"), "---\nname: selected\ndescription: Selected resource\n---\n");
  await writeFile(join(root, "SKILL.md"), "Unselected neighboring resource");
  expect(await resolveSessionSkillPaths(JSON.stringify([selected, join(selected, "SKILL.md")]))).toEqual([join(selected, "SKILL.md")]);
  expect(await resolveSessionSkillPaths(undefined)).toEqual([]);
  expect(await resolveSessionSkillPaths("[]")).toEqual([]);
});

it("rejects malformed, relative, absent and incomplete mounts without exposing private paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "folio-private-skills-"));
  roots.push(root);
  await mkdir(join(root, "SKILL.md"));
  await writeFile(join(root, "other.md"), "Wrong entrypoint");
  for (const value of ["not-json", '{}', '["relative"]', '[42]', JSON.stringify([join(root, "missing")]),
    JSON.stringify([root]), JSON.stringify([join(root, "other.md")])]) {
    await expect(resolveSessionSkillPaths(value)).rejects.toThrow(/^Session skills are unavailable\.$/);
  }
});
