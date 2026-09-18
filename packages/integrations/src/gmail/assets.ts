import { Context, Effect, FileSystem } from 'effect'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IntegrationError } from '../base/index.ts'

/** Electron replaces this source-tree path with the unpacked packaged assets. */
export const GmailAssetsDirectory = Context.Reference<string>('@folio/integrations/gmail/AssetsDirectory', {
  defaultValue: () => fileURLToPath(new URL('./assets', import.meta.url))
})

const skillName = 'gmail-mail'
const skillPath = (root: string) => join(root, 'skills', skillName, 'SKILL.md')
const workflowPath = (root: string) => join(root, 'workflows', 'gmail', 'extract-window.mjs')

export const hasAssets = Effect.fn('Gmail.hasAssets')(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  return (yield* fs.exists(join(directory, 'skills', skillName, 'SKILL.md'))) && (yield* fs.exists(join(directory, 'workflows', 'gmail', 'extract-window.mjs')))
})

/** Publishes bundled assets atomically per file; retries and app upgrades preserve private auth state. */
export const installAssets = Effect.fn('Gmail.installAssets')(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  const source = yield* GmailAssetsDirectory
  if (!(yield* fs.exists(skillPath(source))) || !(yield* fs.exists(workflowPath(source)))) {
    return yield* new IntegrationError({ message: 'The bundled Gmail workflow is missing.' })
  }
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
  yield* fs.chmod(directory, 0o700)
  const staging = yield* fs.makeTempDirectoryScoped({ directory, prefix: '.gmail-assets-' })
  for (const path of [skillPath, workflowPath]) {
    const content = yield* fs.readFileString(path(source))
    const current = yield* fs.readFileString(path(directory)).pipe(
      Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed(undefined)))
    if (current === content) continue
    const staged = path(staging)
    yield* fs.makeDirectory(dirname(staged), { recursive: true, mode: 0o700 })
    yield* fs.writeFileString(staged, content, { mode: 0o600 })
    yield* fs.makeDirectory(dirname(path(directory)), { recursive: true, mode: 0o700 })
    yield* fs.rename(staged, path(directory)).pipe(Effect.uninterruptible)
  }
}, Effect.scoped)

export const installedSkillPath = (directory: string) => skillPath(directory)
export const installedWorkflowPath = (directory: string) => workflowPath(directory)
