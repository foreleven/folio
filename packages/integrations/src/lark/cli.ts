import { Context, Effect, FileSystem } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IntegrationError } from '../base/index.ts'

/** Source-tree default; Electron injects the unpacked application resource path. */
const bundledArchive = (): string | undefined => {
  const suffix = process.platform === 'darwin' && process.arch === 'arm64'
    ? 'darwin-arm64'
    : process.platform === 'linux' && process.arch === 'x64'
      ? 'linux-amd64'
      : undefined
  return suffix ? fileURLToPath(new URL(`./assets/lark-cli-1.0.94-${suffix}.tar.gz`, import.meta.url)) : undefined
}

export const LarkCliArchive = Context.Reference<string>('@folio/integrations/lark/CliArchive', {
  defaultValue: () => bundledArchive() ?? ''
})

/** Verifies executability before publishing an installation as usable. */
const verifyCli = Effect.fn('Lark.verifyCli')(function*(executable: string) {
  yield* Effect.logDebug('Lark CLI verification started')
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const code = yield* spawner.exitCode(ChildProcess.make(executable, ['--version'], {
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore'
  }))
  if (code !== 0) {
    yield* Effect.logWarning('Lark CLI verification failed').pipe(Effect.annotateLogs({ exitCode: code }))
    return yield* new IntegrationError({ message: 'The installed lark-cli could not start.' })
  }
  yield* Effect.logDebug('Lark CLI verification completed')
  return executable
}, Effect.annotateLogs({ integration: 'lark', subsystem: 'cli' }))

/** Returns only the Folio-managed executable; global PATH is intentionally ignored. */
export const findCli = Effect.fn('Lark.findCli')(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  const executable = join(directory, 'cli', process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli')
  if (!(yield* fs.exists(executable))) {
    yield* Effect.logDebug('Lark CLI is not installed')
    return undefined
  }
  yield* Effect.logDebug('Lark CLI installation found')
  return yield* verifyCli(executable)
}, Effect.annotateLogs({ integration: 'lark', subsystem: 'cli' }))

/** Extracts the bundled native CLI after confirmation; staging avoids partial installations. */
export const ensureCli = Effect.fn('Lark.ensureCli')(function*(directory: string) {
  const found = yield* findCli(directory)
  if (found) {
    yield* Effect.logDebug('Reusing installed Lark CLI')
    return found
  }
  const supported = (process.platform === 'darwin' && process.arch === 'arm64') || (process.platform === 'linux' && process.arch === 'x64')
  if (!supported) {
    yield* Effect.logWarning('No bundled Lark CLI matches this platform').pipe(
      Effect.annotateLogs({ platform: process.platform, architecture: process.arch })
    )
    return yield* new IntegrationError({ message: `No bundled lark-cli for ${process.platform}-${process.arch}.` })
  }
  yield* Effect.logInfo('Lark CLI installation started').pipe(
    Effect.annotateLogs({ platform: process.platform, architecture: process.arch })
  )
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
  yield* Effect.logInfo('Lark CLI installation completed')
  return join(tools, 'lark-cli')
}, Effect.tapError(() => Effect.logError('Lark CLI installation failed')),
Effect.annotateLogs({ integration: 'lark', subsystem: 'cli' }), Effect.withLogSpan('lark.ensureCli'))

/** Executes only the Folio-managed CLI and injects the short-lived user token via its environment. */
export const LARK_USER_ACCESS_TOKEN_ENV = 'LARKSUITE_CLI_USER_ACCESS_TOKEN' as const

export const runCli = Effect.fn('Lark.runCli')(function*(directory: string, args: readonly string[], userToken: string) {
  yield* Effect.logDebug('Lark CLI command started').pipe(Effect.annotateLogs({ argumentCount: args.length }))
  const executable = yield* findCli(directory)
  if (!executable) return yield* new IntegrationError({ message: 'The Folio-managed lark-cli is not installed.' })
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const command = ChildProcess.make(executable, [...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', extendEnv: true }).pipe(
    ChildProcess.setEnv({ [LARK_USER_ACCESS_TOKEN_ENV]: userToken })
  )
  const output = yield* spawner.string(command).pipe(
    Effect.mapError(() => new IntegrationError({ message: 'The managed lark-cli command failed.' }))
  )
  yield* Effect.logDebug('Lark CLI command completed')
  return output
}, Effect.tapError(() => Effect.logWarning('Lark CLI command failed')),
Effect.annotateLogs({ integration: 'lark', subsystem: 'cli' }), Effect.withLogSpan('lark.runCli'))
