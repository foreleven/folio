import { methods } from '@agentclientprotocol/sdk/experimental/v2';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { withServer } from '../support/stdio-server.js';

const execute = promisify(execFile);

/** Real Git lifecycle plus production ACP CLI; Codex uses a native protocol fixture, Pi its installed SDK.
 * Only clean temporary worktrees are removed; this probe does not implement Folio's cleanup policy.
 */
it.skipIf(process.platform === 'win32').each(['pi', 'codex'])('restores %s identity and replay after rebuilding a clean worktree at the same path', async agent => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'folio-rebuilt-session-')));
  const main = join(root, 'workspace');
  const cwd = join(root, 'task');
  const git = async (directory: string, ...args: string[]) => (await execute('git', ['-C', directory, ...args], {
    timeout: 5000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  })).stdout.trim();
  try {
    await execute('git', ['init', '--initial-branch=main', main]);
    await git(main, 'config', 'user.name', 'Folio fixture');
    await git(main, 'config', 'user.email', 'fixture@localhost');
    await writeFile(join(main, 'baseline.txt'), 'before\n');
    await git(main, 'add', 'baseline.txt');
    await git(main, 'commit', '-m', 'initial');
    await git(main, 'worktree', 'add', '-b', 'task', cwd);
    const originalHead = await git(cwd, 'rev-parse', 'HEAD');
    await writeFile(join(root, 'config.json'), JSON.stringify({ agent: {
      enabled: true, defaultModelProfileId: 'fixture', modelProfiles: [{ id: 'fixture', name: 'Fixture',
        provider: { type: 'builtin', providerId: 'anthropic' }, modelId: 'claude-sonnet-4-5',
        thinkingLevel: 'medium', credentialSource: 'none' }]
    } }));
    const executable = join(root, 'codex');
    const fixture = (await readFile(new URL('../fixtures/codex-app-server.mjs', import.meta.url), 'utf8'))
      .replaceAll('"native-thread.json"', JSON.stringify(join(root, 'native-thread.json')));
    await writeFile(executable, `#!/usr/bin/env node\n${fixture}`, { mode: 0o700 });
    const options = { args: ['--agent', agent], env: { FOLIO_CODEX_EXECUTABLE: executable } };
    const first = await withServer(root, async (context, updates) => {
      const created = await context.request(methods.agent.session.new, { cwd });
      if (agent === 'pi') await context.request(methods.agent.session.setConfigOption, {
        sessionId: created.sessionId, configId: 'thought_level', type: 'id', value: 'off'
      });
      await context.request(methods.agent.session.close, { sessionId: created.sessionId });
      return { created, updates: [...updates] };
    }, options);
    // Session/native storage lives outside the disposable Task checkout.
    // Commit only fixture diagnostics so Git itself verifies a clean removal.
    await git(cwd, 'add', '-A');
    if (await git(cwd, 'diff', '--cached', '--name-only')) await git(cwd, 'commit', '-m', 'fixture diagnostics');
    await git(main, 'worktree', 'remove', cwd);
    await expect(access(cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    if (agent === 'pi') await withServer(root, async context => {
      // Native Pi accepts a missing cwd: Folio must validate checkout existence before ACP resume.
      const missing = await context.request(methods.agent.session.resume, { sessionId: first.created.sessionId, cwd });
      expect(missing._meta).toEqual(first.created._meta);
      await context.request(methods.agent.session.close, { sessionId: first.created.sessionId });
    }, options);
    await writeFile(join(main, 'baseline.txt'), 'after\n');
    await git(main, 'add', 'baseline.txt');
    await git(main, 'commit', '-m', 'new main baseline');
    await git(main, 'branch', 'rebuilt', 'main');
    await git(main, 'worktree', 'add', cwd, 'rebuilt');
    expect(await git(cwd, 'rev-parse', 'HEAD')).not.toBe(originalHead);
    expect(await readFile(join(cwd, 'baseline.txt'), 'utf8')).toBe('after\n');
    await withServer(root, async (context, updates) => {
      const restored = await context.request(methods.agent.session.resume, {
        sessionId: first.created.sessionId, cwd, replayFrom: { type: 'start' }
      });
      expect(restored._meta).toEqual(first.created._meta);
      expect(updates).toEqual(first.updates);
      if (agent === 'pi') expect(restored.configOptions?.find(option => option.configId === 'thought_level')).toMatchObject({ currentValue: 'off' });
      await context.request(methods.agent.session.close, { sessionId: first.created.sessionId });
    }, options);
    expect(await readFile(join(cwd, 'baseline.txt'), 'utf8')).toBe('after\n');
    expect(await git(cwd, 'diff', '--name-only')).toBe('');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 20000);
