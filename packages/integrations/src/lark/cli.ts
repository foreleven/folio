import { Context, Effect, FileSystem } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IntegrationError } from '../base/index.ts'

/** Source-tree default; Electron injects the unpacked application resource path. */
export const LarkCliArchive = Context.Reference<string>('@folio/integrations/lark/CliArchive', {
  defaultValue: () => fileURLToPath(new URL('./assets/lark-cli-1.0.94-darwin-arm64.tar.gz', import.meta.url))
})

/** Verifies executability before publishing an installation as usable. */
const verifyCli = Effect.fn('Lark.verifyCli')(function*(executable: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const code = yield* spawner.exitCode(ChildProcess.make(executable, ['--version'], {
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore'
  }))
  if (code !== 0) return yield* new IntegrationError({ message: 'The installed lark-cli could not start.' })
  return executable
})

/** Returns only the Folio-managed executable; global PATH is intentionally ignored. */
export const findCli = Effect.fn('Lark.findCli')(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  const executable = join(directory, 'cli', process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli')
  if (!(yield* fs.exists(executable))) return undefined
  return yield* verifyCli(executable)
})

/** Extracts the bundled native CLI after confirmation; staging avoids partial installations. */
export const ensureCli = Effect.fn('Lark.ensureCli')(function*(directory: string) {
  const found = yield* findCli(directory)
  if (found) return found
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    return yield* new IntegrationError({ message: `No bundled lark-cli for ${process.platform}-${process.arch}.` })
  }
  const archive = yield* LarkCliArchive
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  if (!(yield* fs.exists(archive))) return yield* new IntegrationError({ message: 'The bundled lark-cli archive is missing.' })
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
  const staging = join(directory, '.cli-staging')
  yield* fs.remove(staging, { recursive: true, force: true })
  yield* fs.makeDirectory(staging, { recursive: true, mode: 0o700 })
  const code = yield* spawner.exitCode(ChildProcess.make('/usr/bin/tar', ['-xzf', archive, '-C', staging], {
    stdin: 'ignore', stdout: 'ignore', stderr: 'inherit'
  }))
  if (code !== 0) return yield* new IntegrationError({ message: 'Could not extract the bundled lark-cli.' })
  const stagedExecutable = join(staging, 'lark-cli')
  if (!(yield* fs.exists(stagedExecutable))) return yield* new IntegrationError({ message: 'CLI archive did not produce an executable.' })
  yield* fs.chmod(stagedExecutable, 0o700)
  yield* verifyCli(stagedExecutable)
  const tools = join(directory, 'cli')
  yield* fs.remove(tools, { recursive: true, force: true })
  yield* fs.rename(staging, tools)
  return join(tools, 'lark-cli')
})

/** Executes only the Folio-managed CLI and injects the short-lived user token via its environment. */
export const LARK_USER_ACCESS_TOKEN_ENV = 'LARK_USER_ACCESS_TOKEN' as const

export const runCli = Effect.fn('Lark.runCli')(function*(directory: string, args: readonly string[], userToken: string) {
  const executable = yield* findCli(directory)
  if (!executable) return yield* new IntegrationError({ message: 'The Folio-managed lark-cli is not installed.' })
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const command = ChildProcess.make(executable, [...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }).pipe(
    ChildProcess.setEnv({ [LARK_USER_ACCESS_TOKEN_ENV]: userToken })
  )
  return yield* spawner.string(command).pipe(
    Effect.mapError(() => new IntegrationError({ message: 'The managed lark-cli command failed.' }))
  )
})
