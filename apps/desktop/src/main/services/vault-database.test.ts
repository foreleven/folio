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
