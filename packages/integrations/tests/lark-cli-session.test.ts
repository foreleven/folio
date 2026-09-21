import { NodeServices } from '@effect/platform-node'
import { Effect, Logger } from 'effect'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { runCli } from '../src/lark/cli.ts'
import { ingestLarkIm } from '../src/lark/ingest.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'folio-lark-cli-session-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it.skipIf(process.platform === 'win32')('verifies the Lark CLI once for all commands in one ingestion', async () => {
  const integrationDirectory = join(root, 'integration')
  const cliDirectory = join(integrationDirectory, 'cli')
  const commandLog = join(integrationDirectory, 'commands.jsonl')
  await mkdir(cliDirectory, { recursive: true })
  await writeFile(join(integrationDirectory, 'private.json'), JSON.stringify({
    version: 1,
    installed: true,
    app: { clientId: 'app', clientSecret: 'secret', brand: 'feishu' },
    userAuth: { clientId: 'app', brand: 'feishu', accessToken: 'token', expiresAt: Date.now() + 60_000, openId: 'ou_me' }
  }))
  const executable = join(cliDirectory, 'lark-cli')
  await writeFile(executable, `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(commandLog)}, JSON.stringify(args) + '\\n')
if (args[0] === '--version') { console.log('lark-cli version 1.0.96'); process.exit(0) }
if (args[1] === '+messages-search') {
  console.log(JSON.stringify({ data: { messages: [{
    message_id: 'om_1', chat_id: 'oc_1', chat_name: 'Release Team', chat_type: 'group',
    create_time: '1789948810', sender: { id: 'ou_alice', name: 'Alice' }, content: { text: 'Ready' }
  }], has_more: false } }))
  process.exit(0)
}
console.log(JSON.stringify({ data: { items: [{ chat_id: 'oc_1', is_muted: false }] } }))
`)
  await chmod(executable, 0o700)

  const window = {
    start: Date.parse('2026-09-21T00:00:00.000Z'),
    end: Date.parse('2026-09-21T01:00:00.000Z'),
    timeZone: 'Asia/Shanghai'
  }
  await Effect.runPromise(ingestLarkIm({
    integrationDirectory,
    outputDirectory: join(root, 'output'),
    window
  }).pipe(Effect.provide(NodeServices.layer)))

  const commands = (await readFile(commandLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
  expect(commands.filter(args => args[0] === '--version')).toHaveLength(1)
  expect(commands.filter(args => args[1] === '+messages-search')).toHaveLength(1)
  expect(commands.filter(args => args[1] === 'chat.user_setting')).toHaveLength(1)
})

it.skipIf(process.platform === 'win32')('logs sanitized Lark CLI failure details', async () => {
  const integrationDirectory = join(root, 'failing-integration')
  const cliDirectory = join(integrationDirectory, 'cli')
  await mkdir(cliDirectory, { recursive: true })
  const executable = join(cliDirectory, 'lark-cli')
  await writeFile(executable, `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('lark-cli version 1.0.96'); process.exit(0) }
console.error(JSON.stringify({ ok: false, error: {
  type: 'api', subtype: 'invalid_parameters', code: 99992402,
  message: 'API call failed: fixture-sensitive-filter fixture-secret-token', log_id: 'fixture-log-id'
} }))
process.exit(1)
`)
  await chmod(executable, 0o700)
  const logs: unknown[] = []
  const logger = Logger.make(({ message }) => { logs.push(message) })

  const error = await Effect.runPromise(runCli(
    integrationDirectory,
    ['mail', '+triage', '--filter', 'fixture-sensitive-filter'],
    'fixture-secret-token'
  ).pipe(Effect.flip, Effect.provide(NodeServices.layer), Effect.provide(Logger.layer([logger]))))

  expect(error).toMatchObject({ _tag: 'IntegrationError', message: 'The managed lark-cli command failed.' })
  const output = JSON.stringify(logs)
  expect(output).toContain('Lark CLI command exited unsuccessfully')
  expect(output).toContain('mail +triage')
  expect(output).toContain('99992402')
  expect(output).toContain('fixture-log-id')
  expect(output).toContain('invalid_parameters')
  expect(output).not.toContain('fixture-sensitive-filter')
  expect(output).not.toContain('fixture-secret-token')
})
