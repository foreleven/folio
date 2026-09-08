import { Effect, FileSystem } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import { join } from 'node:path'
import { IntegrationError } from '../integration.ts'

/** Finds and verifies a system or managed CLI without installing anything. */
export const findCli = Effect.fn('Lark.findCli')(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const available = yield* spawner.exitCode(ChildProcess.make('lark-cli', ['--version'], {
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore'
  })).pipe(Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed(null)))
  if (available !== null) {
    if (available !== 0) return yield* new IntegrationError({ message: 'The system lark-cli could not start.' })
    return 'lark-cli'
  }

  const tools = join(directory, 'cli')
  const executable = join(tools, 'node_modules', '@larksuite', 'cli', 'bin',
    process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli')
  if (!(yield* fs.exists(executable))) return undefined
  const code = yield* spawner.exitCode(ChildProcess.make(executable, ['--version'], {
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore'
  }))
  if (code !== 0) return yield* new IntegrationError({ message: 'The installed lark-cli could not start.' })
  return executable
})

/** Installs locally only after confirmation; PATH installations are reused. */
export const ensureCli = Effect.fn('Lark.ensureCli')(function*(directory: string) {
  const found = yield* findCli(directory)
  if (found) return found
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const tools = join(directory, 'cli')
  yield* fs.makeDirectory(tools, { recursive: true, mode: 0o700 })
  const code = yield* spawner.exitCode(ChildProcess.make(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
    'install', '--prefix', tools, '--save-exact', '--no-audit', '--no-fund', '@larksuite/cli@1.0.94'
  ], { cwd: directory, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' }))
  if (code !== 0) return yield* new IntegrationError({ message: 'Could not install lark-cli.' })
  const command = yield* findCli(directory)
  if (!command) return yield* new IntegrationError({ message: 'CLI installation did not produce an executable.' })
  return command
})
