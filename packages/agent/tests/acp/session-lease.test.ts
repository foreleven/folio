import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionLeaseStore } from '../../src/acp/session-lease.js';

const roots: string[] = [];
const children: ChildProcess[] = [];
const native = { agent: 'codex' as const, nativeSessionId: 'native' };
/** Each test uses a private database; process cleanup precedes removing its directory. */
async function store() {
  const root = await mkdtemp(join(tmpdir(), 'folio-lease-'));
  roots.push(root);
  return new SessionLeaseStore(root);
}
/** Reaps the process so kill(pid, 0) can conclusively observe its death. */
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}
/** Runs the built production lease store in an independent process. */
async function owner(directory: string, worker?: number) {
  const child = spawn(process.execPath, [resolve('tests/fixtures/session-owner.mjs'), directory, String(worker ?? 0)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.push(child);
  child.stderr!.resume();
  await Promise.race([
    once(child, 'message'),
    once(child, 'exit').then(() => { throw new Error('Owner exited before acquiring ownership'); }),
  ]);
  return child;
}
afterEach(async () => {
  await Promise.all(children.splice(0).map(kill));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('durable session ownership', () => {
  it('releases a Worker that exited before creating a store without creating evidence', async () => {
    const leases = await store();
    await leases.releaseExitedThread(1);
    await expect(access(join(leases.directory, 'execution-owners.db'))).rejects.toThrow();
  });
  it('does not create missing ownership evidence while recovering or releasing', async () => {
    const leases = await store();
    const filename = join(leases.directory, 'execution-owners.db');
    await expect(leases.acquire('session', native, { requireExistingStore: true })).rejects.toMatchObject({ reason: 'unavailable' });
    await expect(access(filename)).rejects.toThrow();
    const first = await leases.acquire('session', native);
    await first.release();
    const recovering = await leases.acquire('session', native, { requireExistingStore: true });
    await recovering.release();
    const db = new DatabaseSync(filename);
    try {
      db.exec('DROP TABLE session_owners');
      await expect(leases.acquire('session', native, { requireExistingStore: true })).rejects.toMatchObject({ reason: 'unavailable' });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='session_owners'").all()).toEqual([]);
    } finally { db.close(); }
    const live = await leases.acquire('session');
    await rm(filename);
    await expect(live.release()).rejects.toMatchObject({ reason: 'unavailable' });
    await expect(access(filename)).rejects.toThrow();
  });

  it('keeps the native identity and worker immutable after binding', async () => {
    const leases = await store();
    const lease = await leases.acquire('session', native);
    await expect(lease.bind({ ...native, nativeSessionId: 'different' }, process.pid)).rejects.toMatchObject({ reason: 'unavailable' });
    await lease.bind(native, process.pid);
    await lease.bind(native, process.pid);
    await expect(lease.bind(native, process.pid + 1)).rejects.toMatchObject({ reason: 'unavailable' });
    await lease.release();
  });

  it('serializes concurrent claims and rolls back an ACP claim when native ownership is busy', async () => {
    const first = await store();
    const second = new SessionLeaseStore(first.directory);
    const results = await Promise.allSettled([first.acquire('session', native), second.acquire('session', native)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { reason: 'busy' } });
    await expect(second.acquire('other', native)).rejects.toMatchObject({ reason: 'busy' });
    const independent = await second.acquire('other');
    await independent.release();
    for (const result of results) if (result.status === 'fulfilled') await result.value.release();
    const replacement = await second.acquire('session', native);
    for (const result of results) if (result.status === 'fulfilled') await result.value.release();
    await expect(first.acquire('session')).rejects.toMatchObject({ reason: 'busy' });
    await replacement.release();
  });

  it('does not steal a suspended live process and recovers after its death', async () => {
    const leases = await store();
    const child = await owner(leases.directory);
    if (process.platform !== 'win32') child.kill('SIGSTOP');
    await expect(leases.acquire('session', native)).rejects.toMatchObject({ reason: 'busy' });
    await kill(child);
    const recovered = await leases.acquire('session', native);
    await recovered.release();
  });

  it('retains a dead parent ownership while its registered worker lives', async () => {
    const leases = await store();
    const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(worker);
    await once(worker, 'spawn');
    const child = await owner(leases.directory, worker.pid!);
    await kill(child);
    await expect(leases.acquire('session', native)).rejects.toMatchObject({ reason: 'busy' });
    await kill(worker);
    const recovered = await leases.acquire('session', native);
    await recovered.release();
  });

  it('refuses release while the native worker is alive', async () => {
    const leases = await store();
    const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(worker);
    await once(worker, 'spawn');
    const lease = await leases.acquire('session');
    await lease.bind(native, worker.pid!);
    await expect(lease.release()).rejects.toMatchObject({ reason: 'worker_running' });
    await kill(worker);
    await lease.release();
  });

  it('fails closed for foreign hosts and malformed ownership records', async () => {
    const leases = await store();
    const lease = await leases.acquire('session');
    const db = new DatabaseSync(join(leases.directory, 'execution-owners.db'));
    try {
      db.prepare('UPDATE session_owners SET host = ?').run('another-host');
      await expect(leases.acquire('session')).rejects.toMatchObject({ reason: 'busy' });
      db.prepare('UPDATE session_owners SET owner_pid = ?').run('invalid');
      await expect(leases.acquire('session')).rejects.toMatchObject({ reason: 'unavailable' });
    } finally { db.close(); }
    // Intentionally retain the invalid receipt: it must never be silently removed.
    void lease;
  });
});
