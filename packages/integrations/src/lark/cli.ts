import { Context, Effect, FileSystem, Schema, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IntegrationError } from '../base/index.ts'

export const LARK_CLI_VERSION = '1.0.96' as const

/** Source-tree default; Electron injects the unpacked application resource path. */
const bundledArchive = (): string | undefined => {
  const suffix = process.platform === 'darwin' && process.arch === 'arm64'
    ? 'darwin-arm64'
    : process.platform === 'linux' && process.arch === 'x64'
      ? 'linux-amd64'
      : undefined
  return suffix ? fileURLToPath(new URL(`./assets/lark-cli-${LARK_CLI_VERSION}-${suffix}.tar.gz`, import.meta.url)) : undefined
}

export const LarkCliArchive = Context.Reference<string>('@folio/integrations/lark/CliArchive', {
  defaultValue: () => bundledArchive() ?? ''
})

const CliVersionOutput = Schema.String.check(
  Schema.isPattern(/^lark-cli version \d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/)
)

interface CliInstallation {
  readonly executable: string
  readonly version: string
}

/** Verifies executability and reads the release identity before publishing an installation as usable. */
const inspectCli = Effect.fn('Lark.inspectCli')(function*(executable: string): Effect.fn.Return<
  CliInstallation,
  IntegrationError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  yield* Effect.logDebug('Lark CLI verification started')
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const [stdout, exitCode] = yield* Effect.scoped(Effect.gen(function* () {
    const handle = yield* spawner.spawn(ChildProcess.make(executable, ['--version'], {
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'
    }))
    return yield* Effect.all([
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.stderr.pipe(Stream.runDrain),
      handle.exitCode
    ], { concurrency: 'unbounded' }).pipe(Effect.map(([output, , code]) => [output, code] as const))
  })).pipe(Effect.mapError(() => new IntegrationError({ message: 'The installed lark-cli could not start.' })))
  if (exitCode !== 0) {
    yield* Effect.logWarning('Lark CLI verification failed').pipe(Effect.annotateLogs({ exitCode }))
    return yield* new IntegrationError({ message: 'The installed lark-cli could not start.' })
  }
  const output = yield* Schema.decodeUnknownEffect(CliVersionOutput)(stdout.trim()).pipe(
    Effect.mapError(() => new IntegrationError({ message: 'The installed lark-cli reported an invalid version.' }))
  )
  const version = output.slice('lark-cli version '.length)
  yield* Effect.logDebug('Lark CLI verification completed').pipe(Effect.annotateLogs({ version }))
  return { executable, version }
}, Effect.annotateLogs({ integration: 'lark', subsystem: 'cli' }))

/** Returns only a verified Folio-managed installation; global PATH is intentionally ignored. */
const findCliInstallation = Effect.fn('Lark.findCliInstallation')(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  const executable = join(directory, 'cli', process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli')
  if (!(yield* fs.exists(executable))) {
    yield* Effect.logDebug('Lark CLI is not installed')
    return undefined
  }
  yield* Effect.logDebug('Lark CLI installation found')
  return yield* inspectCli(executable)
}, Effect.annotateLogs({ integration: 'lark', subsystem: 'cli' }))

/** Returns only the Folio-managed executable; global PATH is intentionally ignored. */
export const findCli = Effect.fn('Lark.findCli')(function*(directory: string) {
  return (yield* findCliInstallation(directory))?.executable
})

/** Extracts the expected bundled release; staging avoids publishing a partial installation. */
export const ensureCli = Effect.fn('Lark.ensureCli')(function*(directory: string) {
  const found = yield* findCliInstallation(directory)
  if (found?.version === LARK_CLI_VERSION) {
    yield* Effect.logDebug('Reusing installed Lark CLI')
    return found.executable
  }
  if (found) {
    yield* Effect.logInfo('Lark CLI upgrade started').pipe(Effect.annotateLogs({
      installedVersion: found.version,
      expectedVersion: LARK_CLI_VERSION
    }))
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
  const staged = yield* inspectCli(stagedExecutable)
  if (staged.version !== LARK_CLI_VERSION) {
    return yield* new IntegrationError({ message: 'The bundled lark-cli version does not match the application.' })
  }
  const tools = join(directory, 'cli')
  const backup = join(directory, '.cli-backup')
  // Keep the last verified release recoverable until publication succeeds.
  // The swap is uninterruptible so cancellation cannot strand the managed CLI between names.
  yield* Effect.uninterruptible(Effect.gen(function* () {
    yield* fs.remove(backup, { recursive: true, force: true })
    const replacing = yield* fs.exists(tools)
    if (replacing) yield* fs.rename(tools, backup)
    yield* fs.rename(staging, tools).pipe(
      Effect.onError(() => replacing ? fs.rename(backup, tools).pipe(Effect.orDie) : Effect.void)
    )
    yield* fs.remove(backup, { recursive: true, force: true })
  }))
  yield* Effect.logInfo('Lark CLI installation completed')
  return join(tools, 'lark-cli')
}, Effect.tapError(() => Effect.logError('Lark CLI installation failed')),
Effect.annotateLogs({ integration: 'lark', subsystem: 'cli' }), Effect.withLogSpan('lark.ensureCli'))

/** Executes only the Folio-managed CLI and injects the short-lived user token via its environment. */
export const LARK_USER_ACCESS_TOKEN_ENV = 'LARKSUITE_CLI_USER_ACCESS_TOKEN' as const

export interface LarkCli {
  readonly run: (args: readonly string[], userToken: string, environment?: Readonly<Record<string, string>>) =>
    Effect.Effect<string, IntegrationError, ChildProcessSpawner.ChildProcessSpawner>
}

const CliFailure = Schema.Struct({
  error: Schema.Struct({
    type: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-z0-9._-]{1,64}$/i))),
    subtype: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-z0-9._-]{1,64}$/i))),
    code: Schema.optional(Schema.Union([
      Schema.Number,
      Schema.String.check(Schema.isPattern(/^\d{1,20}$/))
    ])),
    log_id: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-z0-9_-]{1,128}$/i)))
  })
})

/** Extracts only provider diagnostics that are safe to log; command arguments and stderr stay private. */
const cliFailureDetails = (args: readonly string[], exitCode: number, stderr: string): Record<string, unknown> => {
  const safeSegment = (value: string | undefined): string => value && /^[+a-z0-9._-]+$/i.test(value) ? value : '[redacted]'
  const details: Record<string, unknown> = {
    command: `${safeSegment(args[0])} ${safeSegment(args[1])}`,
    exitCode,
    stderrBytes: Buffer.byteLength(stderr)
  }
  const start = stderr.indexOf('{')
  if (start < 0) return details
  try {
    const parsed = Schema.decodeUnknownSync(CliFailure)(JSON.parse(stderr.slice(start)))
    return {
      ...details,
      ...(parsed.error.type ? { errorType: parsed.error.type } : {}),
      ...(parsed.error.subtype ? { errorSubtype: parsed.error.subtype } : {}),
      ...(parsed.error.code !== undefined ? { errorCode: parsed.error.code } : {}),
      ...(parsed.error.log_id ? { logId: parsed.error.log_id } : {})
    }
  } catch {
    return details
  }
}

const runVerifiedCli = Effect.fn('Lark.runCli')(function*(executable: string, args: readonly string[], userToken: string,
  environment: Readonly<Record<string, string>> = {}) {
  yield* Effect.logDebug('Lark CLI command started').pipe(Effect.annotateLogs({ argumentCount: args.length }))
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const command = ChildProcess.make(executable, [...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', extendEnv: true }).pipe(
    ChildProcess.setEnv({ ...environment, [LARK_USER_ACCESS_TOKEN_ENV]: userToken })
  )
  const execution = yield* Effect.scoped(Effect.gen(function* () {
    const handle = yield* spawner.spawn(command)
    return yield* Effect.all([
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
      handle.exitCode
    ], { concurrency: 'unbounded' })
  })).pipe(
    Effect.mapError(() => new IntegrationError({ message: 'The managed lark-cli command failed.' }))
  )
  const [output, stderr, exitCode] = execution
  if (exitCode !== 0) {
    yield* Effect.logError('Lark CLI command exited unsuccessfully', cliFailureDetails(args, exitCode, stderr))
    return yield* new IntegrationError({ message: 'The managed lark-cli command failed.' })
  }
  yield* Effect.logDebug('Lark CLI command completed')
  return output
}, Effect.tapError(() => Effect.logWarning('Lark CLI command failed')),
Effect.annotateLogs({ integration: 'lark', subsystem: 'cli' }), Effect.withLogSpan('lark.runCli'))

/** Opens one verified CLI runner for a complete Integration operation. */
export const openCli = Effect.fn('Lark.openCli')(function*(directory: string) {
  const executable = yield* findCli(directory)
  if (!executable) return yield* new IntegrationError({ message: 'The Folio-managed lark-cli is not installed.' })
  const cli: LarkCli = {
    run: (args, userToken, environment) => runVerifiedCli(executable, args, userToken, environment)
  }
  return cli
}, Effect.annotateLogs({ integration: 'lark', subsystem: 'cli' }))

/** Convenience wrapper for callers that execute only one command. */
export const runCli = Effect.fn('Lark.runCliOnce')(function*(directory: string, args: readonly string[], userToken: string,
  environment: Readonly<Record<string, string>> = {}) {
  const cli = yield* openCli(directory)
  return yield* cli.run(args, userToken, environment)
})
