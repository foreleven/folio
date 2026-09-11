import { Context, Effect, FileSystem, Layer, Schema } from 'effect'
import { isAbsolute, join } from 'node:path'
import agentPackage from '../../../../../packages/agent/package.json'

export interface AgentRuntimePaths {
  readonly nodeExecutable: string
  readonly entrypoint: string
  readonly agentVersion: string
  /** Optional local Codex app-server selected by the host environment. */
  readonly codexExecutable?: string
}
/** Missing application artifacts fail explicitly, without searching PATH for another runtime. */
export class AgentRuntimeError extends Schema.TaggedError<AgentRuntimeError>()('AgentRuntimeError', {
  reason: Schema.Literals(['unavailable', 'incompatible']), message: Schema.String
}) {}
const failure = (reason: AgentRuntimeError['reason']) => new AgentRuntimeError({ reason,
  message: reason === 'incompatible' ? 'The Agent runtime does not match this platform.' : 'The bundled Agent runtime is unavailable.' })

/** Resolves the Agent entry built with the app lazily; browsing does not require starting an Agent. */
export class AgentRuntime extends Context.Service<AgentRuntime, {
  readonly get: Effect.Effect<AgentRuntimePaths, AgentRuntimeError>
}>()('folio/services/AgentRuntime') {
  static layer(directory: string) {
    return Layer.effect(AgentRuntime, Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      /** Uses the application executable and a fixed build entry, never renderer-supplied paths. */
      const get = Effect.gen(function*() {
        if (!isAbsolute(directory)) return yield* failure('unavailable')
        const root = yield* fs.realPath(directory)
        const nodeExecutable = process.execPath
        const entrypoint = join(root, 'agent.js')
        for (const path of [entrypoint]) {
          if ((yield* fs.realPath(path)) !== path || (yield* fs.stat(path)).type !== 'File') return yield* failure('unavailable')
        }
        // The process boundary probes Electron in Node mode for SQLite before opening ACP.
        const codexExecutable = process.env.FOLIO_CODEX_EXECUTABLE
        return { nodeExecutable, entrypoint, agentVersion: agentPackage.version,
          ...(codexExecutable && isAbsolute(codexExecutable) ? { codexExecutable } : {}) }
      }).pipe(Effect.mapError(error => error instanceof AgentRuntimeError ? error : failure('unavailable')))
      return AgentRuntime.of({ get })
    }))
  }
}
