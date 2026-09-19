import { Effect } from 'effect';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { loadCodexSkills } from '../../src/codex/skills.js';

let root: string;
let selected: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'folio-codex-skills-test-')));
  selected = join(root, 'selected/SKILL.md');
  await mkdir(dirname(selected));
  await writeFile(selected, '---\nname: selected\ndescription: A selected skill\n---\n');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('uses process-local discovery and forwards only selected enabled files', async () => {
  const calls: { method: string; params: unknown }[] = [];
  const connection = { request: (method: string, params: unknown) => Effect.sync(() => {
    calls.push({ method, params });
    return method === 'skills/list' ? { data: [{ cwd: root, errors: [{ path: '/unrelated', message: 'unrelated diagnostic' }], skills: [
      { name: 'selected', path: selected, enabled: true }, { name: 'unselected', path: '/unselected/SKILL.md', enabled: true },
    ] }] } : {};
  }) };
  expect(await Effect.runPromise(loadCodexSkills(connection, root, [selected, dirname(selected)]))).toEqual([
    { type: 'skill', name: 'selected', path: selected },
  ]);
  expect(calls).toEqual([
    { method: 'skills/extraRoots/set', params: { extraRoots: [dirname(selected)] } },
    { method: 'skills/list', params: { cwds: [root], forceReload: true } },
  ]);
});

it.each(['disabled', 'missing', 'wrong-cwd', 'malformed'])('rejects %s selected resources without native diagnostics', async mode => {
  const connection = { request: (method: string, _params: unknown) => Effect.succeed(method === 'skills/list'
    ? mode === 'malformed' ? { private: 'native-diagnostic' } : { data: [{ cwd: mode === 'wrong-cwd' ? dirname(root) : root, errors: [],
      skills: mode === 'missing' ? [] : [{ name: 'selected', path: selected, enabled: mode !== 'disabled' }],
    }] } : {}) };
  const error = await Effect.runPromise(loadCodexSkills(connection, root, [selected]).pipe(Effect.flip));
  expect(error).toMatchObject({ _tag: 'CodexSkillsError', message: 'Selected Codex skills could not be loaded.' });
  expect(JSON.stringify(error)).not.toContain(root);
  expect(JSON.stringify(error)).not.toContain('native-diagnostic');
});
