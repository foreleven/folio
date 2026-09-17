import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { SessionUpdate, UpdateSessionNotification } from '@agentclientprotocol/sdk/experimental/v2';
import type { AcpSessionBackendFactory } from '../src/acp/session-backend.js';
import { openAgentExecution } from '../src/runtime/execution.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'folio-direct-execution-')); roots.push(root);
  const events: UpdateSessionNotification[] = [];
  let submitted = 0;
  let emit!: (update: SessionUpdate) => Promise<void>;
  const backend: AcpSessionBackendFactory = { agent: 'codex', create: async input => {
    emit = input.onUpdate;
    return { processId: process.pid, native: async () => ({ agent: 'codex', nativeSessionId: 'native' }),
      state: async () => 'idle', config: async () => [], setConfig: async () => [],
      prompt: async () => { submitted++; await emit({ sessionUpdate: 'state_update', state: 'running' }); },
      cancel: async () => { await emit({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'cancelled' }); }, close: async () => {} };
  } };
  const options = { agent: 'codex' as const, sessionId: 'session', cwd: root, configDirectory: root,
    agentDirectory: root, storageDirectory: root, runtimeDirectory: join(root, 'runtime'),
    onUpdate: async (event: UpdateSessionNotification) => { events.push(event); } };
  return { options, backend, events, count: () => submitted };
}

it('awaits durable terminal delivery, rejects concurrent prompts and resumes without redispatch', async () => {
  const f = await fixture();
  const session = await openAgentExecution(f.options, f.backend);
  const execution = session.execute('hello');
  await expect(session.execute('duplicate')).rejects.toThrow('busy');
  await session.cancel();
  expect((await execution).update).toMatchObject({ state: 'idle', stopReason: 'cancelled' });
  await session.dispose();
  const before = f.events.slice();
  const resumed = await openAgentExecution({ ...f.options, resume: true }, f.backend);
  expect(f.events.slice(before.length)).toEqual(before);
  expect(f.count()).toBe(1);
  await resumed.dispose();
});

it('retains archived messages after host delivery fails and does not execute again', async () => {
  const f = await fixture();
  const session = await openAgentExecution({ ...f.options, onUpdate: async () => { throw new Error('journal unavailable'); } }, f.backend);
  await expect(session.execute('hello')).rejects.toThrow('journal unavailable');
  await expect(session.execute('again')).rejects.toThrow('journal unavailable');
  await session.dispose();
  const resumed = await openAgentExecution({ ...f.options, resume: true }, f.backend);
  expect(f.events[0]?.update).toMatchObject({ state: 'running' });
  expect(f.events.at(-1)?.update).toMatchObject({ state: 'idle', stopReason: 'cancelled' });
  expect(f.count()).toBe(1);
  await resumed.dispose();
});
