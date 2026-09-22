import { Effect, Exit } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { vaultDatabaseLayer } from './vault-database'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'folio-database-test-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('vaultDatabaseLayer', () => {
  it('creates the final ledger directly and preserves completed messages when reopened', async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master
        WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'effect_sql_migrations' ORDER BY name`
      expect(tables.map(row => row.name)).toEqual([
        'git_operation_runs', 'git_operations', 'messages', 'raws', 'routine_schedules', 'routines', 'runs', 'sessions',
        'tasks', 'wiki_object_types', 'wiki_pages'
      ])
      expect(yield* sql`SELECT migration_id, name FROM effect_sql_migrations`).toEqual([{ migration_id: 1, name: 'vault' }])
      yield* sql`INSERT INTO tasks (id, type, configuration, receipt, state, created_at)
        VALUES ('task', 'agent', '{"goal":"Test","agent":"pi","model":null,"skillIds":[],"integrationIds":[],"resourceIds":[]}', NULL, 'active', 1)`
      yield* sql`INSERT INTO sessions (id, task_id, agent, adapter_version, purpose, created_at)
        VALUES ('session', 'task', 'pi', '1', 'task', 1)`
      yield* sql`INSERT INTO messages (id, session_id, run_id, seq, type, timestamp, payload)
        VALUES ('message', 'session', NULL, 1, 'message', 1, '{"kind":"tool_call"}')`
    }).pipe(Effect.provide(vaultDatabaseLayer(root))))
    await Effect.runPromise(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      expect(yield* sql`SELECT id, seq, type, payload FROM messages`).toEqual([
        { id: 'message', seq: 1, type: 'message', payload: '{"kind":"tool_call"}' }
      ])
      expect(yield* sql`PRAGMA foreign_key_check`).toEqual([])
      expect(yield* sql`PRAGMA integrity_check`).toEqual([{ integrity_check: 'ok' }])
    }).pipe(Effect.provide(vaultDatabaseLayer(root))))
  })

  it('persists isolated vault data across connection scopes and serializes concurrent transactions', async () => {
    const directories = [join(root, 'first'), join(root, 'second')]
    await Promise.all(directories.map((directory) => mkdir(directory)))
    for (const [index, directory] of directories.entries()) {
      await Effect.runPromise(Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TABLE notes (id INTEGER PRIMARY KEY, content TEXT NOT NULL)`
        yield* Effect.all(Array.from({ length: 10 }, (_, id) =>
          sql.withTransaction(sql`INSERT INTO notes (id, content) VALUES (${id}, ${`vault-${index}`})`)
        ), { concurrency: 'unbounded' })
        // A failed transaction must not leave partial user data behind.
        yield* sql.withTransaction(Effect.gen(function*() {
          yield* sql`INSERT INTO notes (id, content) VALUES (99, 'rolled back')`
          return yield* Effect.fail('rollback')
        })).pipe(Effect.flip)
      }).pipe(Effect.provide(vaultDatabaseLayer(directory))))
    }
    for (const [index, directory] of directories.entries()) {
      const rows = await Effect.runPromise(Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        return yield* sql`SELECT id, content FROM notes ORDER BY id`
      }).pipe(Effect.provide(vaultDatabaseLayer(directory))))
      expect(rows).toEqual(Array.from({ length: 10 }, (_, id) => ({ id, content: `vault-${index}` })))
    }
  })

  it('keeps active Git operations mutually exclusive with ordinary Runs while allowing their conflict Run', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const configuration = '{"goal":"Test","agent":"pi","model":null,"skillIds":[],"integrationIds":[],"resourceIds":[]}'
      yield* sql`INSERT INTO tasks (id, type, configuration, receipt, state, created_at)
        VALUES ('task', 'agent', ${configuration}, NULL, 'active', 1),
          ('busy-task', 'agent', ${configuration}, NULL, 'active', 1)`
      yield* sql`INSERT INTO git_operations
        (id, task_id, kind, state, source_commit, target_commit, artifact_path, created_at, updated_at)
        VALUES ('conflict', 'task', 'synchronize', 'conflict', ${'a'.repeat(40)}, ${'b'.repeat(40)},
          'git-operations/conflict/operation.json', 1, 1)`
      yield* sql`INSERT INTO sessions (id, task_id, agent, adapter_version, purpose, sync_operation_id, created_at)
        VALUES ('task-session', 'task', 'pi', '1', 'task', NULL, 1),
          ('conflict-session', 'task', 'pi', '1', 'conflict-resolution', 'conflict', 1),
          ('busy-session', 'busy-task', 'pi', '1', 'task', NULL, 1)`
      yield* sql`INSERT INTO runs
        (id, task_id, session_id, prompt, purpose, source, owner, started_at, state, sync_state, created_at)
        VALUES ('conflict-run', 'task', 'conflict-session', 'resolve', 'conflict-resolution',
          'conflict-resolution', 'worker', 2, 'preparing', 'not-required', 1)`
      expect(yield* sql`INSERT INTO runs
        (id, task_id, session_id, prompt, purpose, source, owner, started_at, state, sync_state, created_at)
        VALUES ('ordinary-run', 'task', 'task-session', 'work', 'execution', 'manual',
          'worker', 2, 'preparing', 'pending', 1)`.pipe(Effect.flip)).toMatchObject({ _tag: 'SqlError' })
      yield* sql`UPDATE runs SET state='cancelled', ended_at=3, owner=NULL WHERE id='conflict-run'`
      yield* sql`INSERT INTO runs
        (id, task_id, session_id, prompt, purpose, source, owner, started_at, state, sync_state, created_at)
        VALUES ('busy-run', 'busy-task', 'busy-session', 'work', 'execution', 'manual',
          'worker', 2, 'preparing', 'pending', 1)`
      expect(yield* sql`INSERT INTO git_operations
        (id, task_id, kind, state, source_commit, target_commit, artifact_path, created_at, updated_at)
        VALUES ('blocked-save', 'busy-task', 'save-user', 'pending', ${'a'.repeat(40)}, ${'b'.repeat(40)},
          'git-operations/blocked-save/operation.json', 1, 1)`.pipe(Effect.flip)).toMatchObject({ _tag: 'SqlError' })
    }).pipe(Effect.provide(vaultDatabaseLayer(root))))
  })

  it.each(['success', 'failure', 'interruption'])('closes the connection after scope %s', async (outcome) => {
    let client: SqlClient.SqlClient | undefined
    const exit = await Effect.runPromiseExit(Effect.gen(function*() {
      client = yield* SqlClient.SqlClient
      yield* client`SELECT 1`
      if (outcome === 'failure') return yield* Effect.fail('failed')
      if (outcome === 'interruption') return yield* Effect.interrupt
    }).pipe(Effect.provide(vaultDatabaseLayer(root))))
    expect(Exit.isSuccess(exit)).toBe(outcome === 'success')
    expect(client).toBeDefined()
    // A retained client must be unusable once its owning scope has ended.
    expect(await Effect.runPromise(Effect.flip(client!`SELECT 2`))).toMatchObject({ _tag: 'SqlError' })
  })
})
