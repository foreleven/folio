import { ModelProfile } from '@folio/agent/config/schema'
import { ndJsonStream } from '@agentclientprotocol/sdk/experimental/v2'
import { Cause, Effect, Queue, Schema, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import { delimiter, dirname, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { AgentKind } from '../../shared/harness'
import type { ProtocolDiagnostic } from '../../shared/harness-events'

const AbsolutePath = Schema.NonEmptyString.check(Schema.makeFilter(isAbsolute))
const Options = Schema.Struct({
  nodeExecutable: AbsolutePath, entrypoint: AbsolutePath, cwd: AbsolutePath,
  configDirectory: AbsolutePath, agentDirectory: AbsolutePath, agent: AgentKind,
  modelProfile: Schema.optional(ModelProfile),
  skillPaths: Schema.optional(Schema.Array(AbsolutePath)),
  executableDirectories: Schema.optional(Schema.Array(AbsolutePath.check(Schema.makeFilter(path => !path.includes(delimiter))))),
  runtimeDirectory: Schema.optionalKey(AbsolutePath),
  sessionStorageDirectory: Schema.optional(AbsolutePath),
  codexExecutable: Schema.optional(AbsolutePath)
})
export type AgentProcessOptions = typeof Options.Type
  & { readonly onMalformedInput?: (diagnostic: ProtocolDiagnostic) => Promise<void> | void }
/** Process failures never include paths, credentials, inherited environment or native stderr. */
export class AgentProcessError extends Schema.TaggedError<AgentProcessError>()('AgentProcessError', {
  reason: Schema.Literals(['invalid-options', 'runtime-unavailable', 'spawn-failed', 'closed']), message: Schema.String
}) {}
const failure = (reason: AgentProcessError['reason']) => new AgentProcessError({ reason, message: `Agent process is unavailable (${reason}).` })

const MAX_DIAGNOSTIC_LINE = 1024 * 1024

/**
 * Observes NDJSON boundaries before the ACP SDK decoder. It forwards bytes unchanged and records
 * only malformed-line metadata, preserving SDK parse-error behavior without retaining wire data.
 */
function observeMalformedInput(input: ReadableStream<Uint8Array>, onMalformed?: AgentProcessOptions['onMalformedInput']): ReadableStream<Uint8Array> {
  if (!onMalformed) return input
  const decoder = new TextDecoder('utf-8', { fatal: true })
  // Keep a fixed sample buffer. A subarray view of a caller-owned chunk can retain a much
  // larger backing ArrayBuffer than the diagnostic cap, and one-byte chunks would otherwise
  // create an array with up to a million entries before inspection.
  const sample = new Uint8Array(MAX_DIAGNOSTIC_LINE)
  let retainedLength = 0
  let length = 0
  let oversized = false
  let digest = createHash('sha256')
  const append = (part: Uint8Array): void => {
    if (!part.length) return
    digest.update(part)
    length = Math.min(MAX_DIAGNOSTIC_LINE + 1, length + part.length)
    const retained = Math.min(part.length, MAX_DIAGNOSTIC_LINE - retainedLength)
    if (retained < part.length) oversized = true
    if (retained) {
      sample.set(part.subarray(0, retained), retainedLength)
      retainedLength += retained
    }
  }
  const inspect = async (final = false): Promise<void> => {
    if (!length) return
    const bytes = sample.subarray(0, retainedLength)
    const currentLength = length
    retainedLength = 0
    length = 0
    const hash = digest.digest('hex'); digest = createHash('sha256')
    let reason: ProtocolDiagnostic['reason'] | undefined
    if (oversized) reason = 'line-too-large'
    else {
      try {
        const text = decoder.decode(bytes).trim()
        if (text && (() => { try { JSON.parse(text); return false } catch { return true } })()) reason = 'invalid-json'
      } catch { reason = 'invalid-utf8' }
    }
    oversized = false
    if (reason) await onMalformed({ reason, byteLength: currentLength, sha256: hash })
    // A non-newline-terminated valid line is still handled by the SDK at EOF; `final` exists to
    // make the flush path explicit and prevent future changes from silently dropping diagnostics.
    void final
  }
  return input.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      let start = 0
      for (let index = 0; index < chunk.length; index++) {
        if (chunk[index] !== 0x0a) continue
        append(chunk.subarray(start, index))
        await inspect()
        start = index + 1
      }
      if (start < chunk.length) append(chunk.subarray(start))
      controller.enqueue(chunk)
    },
    async flush() { await inspect(true) }
  }))
}

/**
 * Opens a Node ACP process using the application executable, leaving Session lifecycle to the ACP client. Runtime and
 * entrypoint must come from trusted application composition; no shell or PATH-based Node fallback.
 * The Scope owns stdin/stdout/stderr and waits for process termination, with a bounded force-kill fallback.
 */
export const openAgentProcess = Effect.fn('AgentProcess.open')(function*(input: AgentProcessOptions) {
  const options = yield* Schema.decodeUnknownEffect(Options)(input).pipe(Effect.mapError(() => failure('invalid-options')))
  if (options.modelProfile && (options.agent !== 'pi' || !options.runtimeDirectory)) return yield* failure('invalid-options')
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  // Probe the executable actually selected, including the SQLite API used by Session ownership.
  // Electron runs as Node in the child; normal Node also accepts this environment.
  const probe = yield* Effect.gen(function*() {
    const runtime = yield* spawner.spawn(ChildProcess.make(options.nodeExecutable, ['-e',
    "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');db.close();process.stdout.write(JSON.stringify({node:process.versions.node,electron:process.versions.electron??null}))"
    ], { cwd: options.cwd, forceKillAfter: '2 seconds', env: { ELECTRON_RUN_AS_NODE: '1' }, extendEnv: true }))
    yield* runtime.stderr.pipe(Stream.runDrain, Effect.forkScoped)
    const output = yield* runtime.stdout.pipe(Stream.decodeText(), Stream.mkString)
    // Valid JSON alone is insufficient: a runtime can fail after producing its version report.
    if ((yield* runtime.exitCode) !== 0) return yield* failure('runtime-unavailable')
    return output
  }).pipe(
    Effect.scoped, Effect.timeout('5 seconds'), Effect.mapError(() => failure('runtime-unavailable'))
  )
  const version = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({
    node: Schema.String.check(Schema.makeFilter(version => /^(2[4-9]|[3-9][0-9])\./.test(version))),
    electron: Schema.NullOr(Schema.String)
  })))(probe).pipe(Effect.mapError(() => failure('runtime-unavailable')))

  const child = yield* spawner.spawn(ChildProcess.make(options.nodeExecutable, [options.entrypoint, '--agent', options.agent], {
    cwd: options.cwd, forceKillAfter: '2 seconds',
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      FOLIO_CONFIG_DIR: options.configDirectory, FOLIO_AGENT_DIR: options.agentDirectory,
      FOLIO_SESSION_STORAGE_DIR: options.sessionStorageDirectory ?? options.agentDirectory,
      FOLIO_SESSION_MODEL_PROFILE: options.modelProfile ? JSON.stringify(options.modelProfile) : '',
      FOLIO_SESSION_RUNTIME_DIR: options.runtimeDirectory ?? '',
      // Empty means no selected mounts; never inherit a different Task's ambient Skill selection.
      FOLIO_SESSION_SKILL_PATHS: JSON.stringify(options.skillPaths ?? []),
      // Expose selected Integration executables; scripts requiring a node command use the user PATH.
      PATH: [dirname(options.nodeExecutable), ...(options.executableDirectories ?? []), process.env.PATH ?? ''].join(delimiter),
      ...(options.codexExecutable ? { FOLIO_CODEX_EXECUTABLE: options.codexExecutable } : {})
    }, extendEnv: true
  })).pipe(Effect.mapError(() => failure('spawn-failed')))
  // A bounded queue provides pipe backpressure instead of buffering an unbounded number of Prompts.
  const outgoing = yield* Queue.bounded<Uint8Array, AgentProcessError | Cause.Done>(16)
  let closed = false
  const stop = Effect.fn('AgentProcess.stop')(function*() {
    if (closed) return
    closed = true
    yield* Queue.fail(outgoing, failure('closed'))
    yield* child.kill({ forceKillAfter: '2 seconds' }).pipe(Effect.catch(() => Effect.void))
  })
  yield* Effect.addFinalizer(() => stop())
  yield* Stream.fromQueue(outgoing).pipe(Stream.run(child.stdin), Effect.catch(() => stop()), Effect.forkScoped)
  // Drain, but do not forward arbitrary account/credential diagnostics into renderer logs.
  yield* child.stderr.pipe(Stream.runDrain, Effect.catch(() => stop()), Effect.forkScoped)
  yield* child.exitCode.pipe(Effect.andThen(Effect.gen(function*() {
    closed = true
    yield* Queue.fail(outgoing, failure('closed'))
  })), Effect.catch(() => stop()), Effect.forkScoped)

  const inputStream = new WritableStream<Uint8Array>({
    async write(bytes) {
      if (closed || !(await Effect.runPromise(Queue.offer(outgoing, bytes)))) throw failure('closed')
    },
    async close() { await Effect.runPromise(Queue.end(outgoing)) },
    async abort() { await Effect.runPromise(stop()) }
  })
  const outputStream = observeMalformedInput(Stream.toReadableStream(child.stdout), input.onMalformedInput)
  return {
    pid: child.pid,
    nodeVersion: version.node,
    stream: ndJsonStream(inputStream, outputStream),
    /** Resolves only for this ACP process; it does not prove arbitrary detached descendants have exited. */
    exited: child.exitCode
  }
})
