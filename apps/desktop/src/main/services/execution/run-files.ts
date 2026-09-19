import { Context, Effect, Layer, Schema } from 'effect'
import { mkdir, open, readFile, readdir, rename, rm, rmdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HarnessStoreError, RunOutcome, SessionBinding, type RunRecord } from '../../../shared/harness'
import { processIdentity } from './process-identity'
import { VaultContext } from '../vault/vault-context'

const PositivePid = Schema.Int.check(Schema.isGreaterThan(0))
const Identity = Schema.Struct({ group: PositivePid, started: Schema.String })
const Process = Schema.Struct({ pid: PositivePid, stopped: Schema.Boolean, identity: Schema.optionalKey(Schema.NullOr(Identity)) })
export const RunFileState = Schema.Struct({
  formatVersion: Schema.Literal(1), vaultId: Schema.String, taskId: Schema.String, sessionId: Schema.String,
  runId: Schema.String, owner: Schema.String, instanceId: Schema.String, ownerPid: PositivePid,
  ownerIdentity: Schema.optionalKey(Schema.NullOr(Identity)), threadId: Schema.NullOr(PositivePid), workerStopped: Schema.Boolean,
  phase: Schema.Literals(['claimed', 'starting', 'active', 'cleaning']),
  processes: Schema.Array(Process), binding: Schema.NullOr(SessionBinding),
  result: Schema.NullOr(Schema.Struct({ outcome: RunOutcome, error: Schema.NullOr(Schema.String) })),
  updatedAt: Schema.Number
})
export type RunFileState = typeof RunFileState.Type
const decode = Schema.decodeUnknownSync(RunFileState)
export const RUN_INSTANCE_ID = randomUUID()
const instanceId = RUN_INSTANCE_ID
const segment = (value: string) => {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid execution path identity')
  return value
}
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
export const RUN_LOG_LIMITS = { fileBytes: 10 * 1024 * 1024, vaultBytes: 100 * 1024 * 1024, retentionMs: 7 * 24 * 60 * 60 * 1000 }

/** One main-process writer per Vault. State is a recovery receipt; JSONL is diagnostic only. */
export class RunFileStore {
  private tail: Promise<unknown> = Promise.resolve()
  private readonly pendingLogs = new Map<string, string[]>()
  constructor(readonly directory: string, readonly vaultId: string) {}
  private path(runId: string, owner: string) { return join(this.directory, 'runtime', 'runs', segment(runId), segment(owner), 'state.json') }
  private serial<A>(operation: () => Promise<A>): Promise<A> {
    const result = this.tail.then(operation)
    this.tail = result.catch(() => undefined)
    return result
  }
  private async write(state: RunFileState) {
    const path = this.path(state.runId, state.owner)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(decode(state))); await file.sync() } finally { await file.close() }
      await rename(temporary, path)
      if (process.platform !== 'win32') {
        const directory = await open(dirname(path), 'r')
        try { await directory.sync() } finally { await directory.close() }
      }
    } finally { await rm(temporary, { force: true }) }
  }
  async read(runId: string, owner: string): Promise<RunFileState | null> {
    let raw: string
    try { raw = await readFile(this.path(runId, owner), 'utf8') } catch (error) { if (missing(error)) return null; throw error }
    const state = decode(JSON.parse(raw))
    if (state.vaultId !== this.vaultId || state.runId !== runId || state.owner !== owner) throw new Error('Execution file identity mismatch')
    return state
  }
  begin(run: RunRecord) {
    return this.serial(async () => {
      if (!run.owner || run.state !== 'preparing') throw new Error('Run is not claimed')
      const previous = await this.read(run.id, run.owner)
      if (previous) {
        if (previous.instanceId !== instanceId) throw new Error('Run belongs to a previous application instance')
        return previous
      }
      const state: RunFileState = { formatVersion: 1, vaultId: this.vaultId, runId: run.id, taskId: run.taskId,
        sessionId: run.sessionId, owner: run.owner, instanceId, ownerPid: process.pid, threadId: null,
        ownerIdentity: await processIdentity(process.pid), workerStopped: true, phase: 'claimed', processes: [], binding: null, result: null, updatedAt: Date.now() }
      await this.write(state)
      return state
    })
  }
  update(runId: string, owner: string, change: (state: RunFileState) => RunFileState) {
    return this.serial(async () => {
      const state = await this.read(runId, owner)
      if (!state) throw new Error('Execution recovery state is missing')
      const next = decode({ ...change(state), updatedAt: Date.now() })
      if (next.runId !== state.runId || next.owner !== state.owner || next.vaultId !== state.vaultId
        || next.taskId !== state.taskId || next.sessionId !== state.sessionId) throw new Error('Execution identity is immutable')
      await this.write(next)
      return next
    })
  }
  async list(): Promise<readonly RunFileState[]> {
    const root = join(this.directory, 'runtime', 'runs')
    let runs: string[]
    try { runs = await readdir(root) } catch (error) { if (missing(error)) return []; throw error }
    const states: RunFileState[] = []
    for (const run of runs) for (const owner of await readdir(join(root, segment(run)))) {
      const state = await this.read(run, owner)
      if (!state) throw new Error('Incomplete execution directory requires inspection')
      states.push(state)
    }
    return states
  }
  remove(runId: string, owner: string) {
    return this.serial(async () => {
      const state = await this.read(runId, owner)
      if (state && (!state.workerStopped || state.processes.some(value => !value.stopped))) throw new Error('Execution resources are still owned')
      await rm(dirname(this.path(runId, owner)), { recursive: true, force: true })
      await rmdir(dirname(dirname(this.path(runId, owner)))).catch(error => { if (!missing(error) && error.code !== 'ENOTEMPTY') throw error })
    })
  }
  private async appendLogBatch(path: string, lines: readonly string[]) {
    const batch = lines.join('')
    const bytes = Buffer.byteLength(batch)
    if (bytes > RUN_LOG_LIMITS.fileBytes) return
    let size = 0
    try { size = (await stat(path)).size } catch (error) { if (!missing(error)) throw error }
    if (size + bytes > RUN_LOG_LIMITS.fileBytes) {
      const previous = path.replace(/\.jsonl$/, '.previous.jsonl')
      await rm(previous, { force: true })
      await rename(path, previous)
    }
    // Terminal retention runs separately. If active logs alone exhaust the budget,
    // stop diagnostics rather than delete recovery state or grow without a bound.
    const root = join(this.directory, 'logs', 'runs')
    let total = 0
    for (const run of await readdir(root)) for (const name of await readdir(join(root, segment(run)))) {
      if (/^[a-zA-Z0-9_-]+(?:\.previous)?\.jsonl$/.test(name)) total += (await stat(join(root, run, name))).size
    }
    if (total + bytes > RUN_LOG_LIMITS.vaultBytes) return
    const file = await open(path, 'a', 0o600)
    try { await file.writeFile(batch) } finally { await file.close() }
  }
  /** Logging failure must not replace the result or invalidate a successful database commit. */
  log(state: RunFileState, event: string, data: Record<string, unknown> = {}) {
    return this.serial(async () => {
      const path = join(this.directory, 'logs', 'runs', segment(state.runId), `${segment(state.owner)}.jsonl`)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const line = JSON.stringify({ formatVersion: 1, timestamp: Date.now(), level: 'info', vaultId: state.vaultId,
        taskId: state.taskId, sessionId: state.sessionId, runId: state.runId, owner: state.owner, event, data }) + '\n'
      const pending = this.pendingLogs.get(path) ?? []
      pending.push(line)
      this.pendingLogs.set(path, pending)
      if (pending.length < 16 && event !== 'committed' && event !== 'recovery') return
      this.pendingLogs.delete(path)
      await this.appendLogBatch(path, pending)
    }).catch(error => { console.warn('[Folio] Execution diagnostic log could not be written', { event, error }) })
  }
  /** Best-effort flush at execution and application boundaries, including failed SQL commits. */
  flush() {
    return this.serial(async () => {
      const batches = [...this.pendingLogs]
      this.pendingLogs.clear()
      for (const [path, lines] of batches) {
        await this.appendLogBatch(path, lines)
      }
    }).catch(error => { console.warn('[Folio] Execution log flush failed', error) })
  }
  /** Deletes only terminal logs, oldest first; runtime state is never subject to retention. */
  prune(terminalRunIds: ReadonlySet<string>) {
    return this.serial(async () => {
      const root = join(this.directory, 'logs', 'runs')
      let runs: string[]
      try { runs = await readdir(root) } catch (error) { if (missing(error)) return; throw error }
      const files: { path: string; size: number; modified: number; terminal: boolean }[] = []
      for (const run of runs) for (const name of await readdir(join(root, segment(run)))) {
        if (!/^[a-zA-Z0-9_-]+(?:\.previous)?\.jsonl$/.test(name)) continue
        const path = join(root, run, name)
        const info = await stat(path)
        files.push({ path, size: info.size, modified: info.mtimeMs, terminal: terminalRunIds.has(run) })
      }
      let total = files.reduce((sum, file) => sum + file.size, 0)
      for (const file of files.sort((a, b) => a.modified - b.modified)) {
        if (!file.terminal || (Date.now() - file.modified <= RUN_LOG_LIMITS.retentionMs && total <= RUN_LOG_LIMITS.vaultBytes)) continue
        await rm(file.path)
        total -= file.size
        await rmdir(dirname(file.path)).catch(error => { if (!missing(error) && error.code !== 'ENOTEMPTY') throw error })
      }
    }).catch(error => { console.warn('[Folio] Execution log retention failed', error) })
  }
}

/** A crash may truncate only the final line. Interior corruption must remain visible. */
export function readRunLog(text: string): readonly unknown[] {
  const lines = text.split('\n')
  lines.pop()
  return lines.filter(Boolean).map(line => JSON.parse(line))
}

const safe = () => new HarnessStoreError({ reason: 'storage', message: 'Execution recovery files could not be verified. Saved state has been retained.' })
export const fileEffect = <A>(operation: () => Promise<A>) => Effect.tryPromise({ try: operation, catch: safe })
export class RunFiles extends Context.Service<RunFiles, RunFileStore>()('folio/services/RunFiles') {
  static readonly layer = Layer.effect(RunFiles, Effect.gen(function* () {
    const vault = yield* VaultContext
    const files = new RunFileStore(vault.directory, vault.id)
    yield* Effect.addFinalizer(() => Effect.promise(() => files.flush()))
    return files
  }))
}
