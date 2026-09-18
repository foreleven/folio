import { Context, Effect, FileSystem } from 'effect'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IntegrationError } from '../base/index.ts'

/** Source-tree default; Electron injects the packaged workflow asset directory. */
export const LarkWorkflowsDirectory = Context.Reference<string>('@folio/integrations/lark/WorkflowsDirectory', {
  defaultValue: () => fileURLToPath(new URL('./assets/workflows', import.meta.url))
})

/** Refreshes the bundled extractor on app upgrades without touching installed Skills or credentials. */
export const ensureExtractor = Effect.fn('Lark.ensureExtractor')(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  const source = yield* LarkWorkflowsDirectory
  const bundled = join(source, 'lark-im', 'extract-window.mjs')
  const installed = join(directory, 'workflows', 'lark-im', 'extract-window.mjs')
  if (!(yield* fs.exists(bundled))) return yield* new IntegrationError({ message: 'The bundled Lark IM workflow is missing.' })
  const content = yield* fs.readFileString(bundled)
  const current = yield* fs.readFileString(installed).pipe(
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed(undefined)))
  if (current === content) return
  const parent = join(directory, 'workflows', 'lark-im')
  yield* fs.makeDirectory(parent, { recursive: true, mode: 0o700 })
  const temporary = yield* fs.makeTempDirectoryScoped({ directory: parent, prefix: '.extractor-' })
  const staged = join(temporary, 'extract-window.mjs')
  yield* fs.writeFileString(staged, content, { mode: 0o600 })
  yield* fs.rename(staged, installed).pipe(Effect.uninterruptible)
}, Effect.scoped)
