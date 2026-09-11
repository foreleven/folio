import { methods } from "@agentclientprotocol/sdk/experimental/v2";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withServer } from "./support/stdio-server.js";
import { expect, it } from "vitest";
import { SessionArchive } from '../src/acp/session-archive.js';
import { SecureCredentialStore } from '../src/model/credential-store.js';

it('rejects missing explicit mounts for both Agents before ACP initialization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'folio-stdio-skills-'));
  try {
    await writeFile(join(directory, 'SKILL.md'), '---\nname: selected\ndescription: Selected resource\n---\n');
    for (const agent of ['pi', 'codex']) await expect(withServer(directory, async () => undefined, {
      args: ['--agent', agent], env: { FOLIO_SESSION_SKILL_PATHS: JSON.stringify([join(directory, 'missing')]) }
    })).rejects.toThrow();
    await expect(access(join(directory, 'agent/acp-sessions'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("restores the same ACP and Pi identity, config and replay after a production CLI process restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "folio-stdio-resume-"));
  try {
    await writeFile(join(directory, "config.json"), JSON.stringify({ agent: {
      enabled: true, defaultModelProfileId: "default",
      modelProfiles: [{ id: "default", name: "Default", provider: { type: "builtin", providerId: "anthropic" },
        modelId: "claude-sonnet-4-5", thinkingLevel: "medium", credentialSource: "none" }],
    } }));
    const created = await withServer(directory, async (context) => {
      const session = await context.request(methods.agent.session.new, { cwd: directory });
      await context.request(methods.agent.session.setConfigOption, { sessionId: session.sessionId, configId: "thought_level", type: "id", value: "off" });
      return session;
    });
    expect(created._meta?.["folio/nativeSessionId"]).toEqual(expect.any(String));
    expect(created._meta?.["folio/nativeSessionId"]).not.toBe(created.sessionId);
    await withServer(directory, async (context, updates) => {
      const listed = await context.request(methods.agent.session.list, {});
      expect(listed.sessions.map((session) => session.sessionId)).toContain(created.sessionId);
      const restored = await context.request(methods.agent.session.resume, { sessionId: created.sessionId, cwd: directory, replayFrom: { type: "start" } });
      expect(restored._meta).toEqual(created._meta);
      expect(restored.configOptions?.find((option) => option.configId === "thought_level")).toMatchObject({ currentValue: "off" });
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({ sessionUpdate: "config_option_update" });
      await context.request(methods.agent.session.close, { sessionId: created.sessionId });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

it('keeps Vault ACP and native Pi history separate while sharing the unchanged Folio credential store', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'folio-vault-history-')));
  const first = join(directory, 'vaults/first/agent-history');
  const second = join(directory, 'vaults/second/agent-history');
  const cwd = join(directory, 'worktree');
  const env = { FOLIO_SESSION_STORAGE_DIR: first, FOLIO_SESSION_RUNTIME_DIR: join(first, 'runtime/selected'),
    FOLIO_SESSION_MODEL_PROFILE: JSON.stringify({ id: 'explicit', name: 'Explicit selection',
      provider: { type: 'builtin', providerId: 'anthropic' }, modelId: 'claude-sonnet-4-5', thinkingLevel: 'medium', credentialSource: 'managed' }) };
  try {
    await mkdir(cwd);
    await writeFile(join(directory, 'config.json'), JSON.stringify({ agent: {
      enabled: true, defaultModelProfileId: 'explicit', modelProfiles: [{ id: 'explicit', name: 'Explicit selection',
        provider: { type: 'builtin', providerId: 'anthropic' }, modelId: 'claude-sonnet-4-5', thinkingLevel: 'off', credentialSource: 'managed' }]
    } }));
    const authPath = join(directory, 'agent/auth.json');
    const credentials = new SecureCredentialStore({ authPath });
    await credentials.modify('anthropic', async () => ({ type: 'api_key', key: 'fixture-no-model-request' }));
    const before = await readFile(authPath, 'utf8');
    const created = await withServer(directory, context => context.request(methods.agent.session.new, { cwd }), { env });
    const archived = await new SessionArchive(join(first, 'acp-sessions')).read(created.sessionId);
    expect(archived.header.native).toMatchObject({ nativeSessionFile: expect.stringContaining(join(first, 'sessions')) });
    expect(JSON.stringify(archived)).not.toContain('fixture-no-model-request');
    await expect(access(join(directory, 'agent/acp-sessions'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(directory, 'agent/sessions'))).rejects.toMatchObject({ code: 'ENOENT' });
    await withServer(directory, async context => {
      expect((await context.request(methods.agent.session.list, {})).sessions).toEqual([]);
      await expect(context.request(methods.agent.session.resume, { sessionId: created.sessionId, cwd, replayFrom: { type: 'start' } })).rejects.toThrow();
    }, { env: { FOLIO_SESSION_STORAGE_DIR: second } });
    await withServer(directory, async context => {
      const restored = await context.request(methods.agent.session.resume, { sessionId: created.sessionId, cwd, replayFrom: { type: 'start' } });
      expect(restored._meta).toEqual(created._meta);
      expect(restored.configOptions).toEqual(created.configOptions);
    }, { env });
    expect(await readFile(authPath, 'utf8')).toBe(before);
    await expect(access(join(first, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 15000);
