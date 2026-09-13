import { Context, Effect, FileSystem } from 'effect'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IntegrationError } from '../base/index.ts'

/** Source-tree default; Electron injects the packaged workflow asset directory. */
export const LarkWorkflowsDirectory = Context.Reference<string>('@folio/integrations/lark/WorkflowsDirectory', {
  defaultValue: () => fileURLToPath(new URL('./assets/workflows', import.meta.url))
})

/** Adds the workflow extractor to an existing installation without touching its Skills. */
export const ensureExtractor = Effect.fn('Lark.ensureExtractor')(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  const source = yield* LarkWorkflowsDirectory
  const bundled = join(source, 'lark-im', 'extract-window.mjs')
  const installed = join(directory, 'workflows', 'lark-im', 'extract-window.mjs')
  if (!(yield* fs.exists(bundled))) return yield* new IntegrationError({ message: 'The bundled Lark IM workflow is missing.' })
  if (!(yield* fs.exists(installed))) {
    yield* fs.makeDirectory(join(directory, 'workflows', 'lark-im'), { recursive: true, mode: 0o700 })
    yield* fs.copy(bundled, installed)
  }
  if (!(yield* fs.exists(installed))) return yield* new IntegrationError({ message: 'The Lark IM workflow could not be installed.' })
})
