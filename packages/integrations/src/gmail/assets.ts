import { Context, Effect, FileSystem } from 'effect'
import { join } from 'node:path'
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

/** Stages the credential-free Skill and extractor after explicit installation. */
export const installAssets = Effect.fn('Gmail.installAssets')(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  const source = yield* GmailAssetsDirectory
  if (yield* hasAssets(directory)) return
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
  yield* fs.chmod(directory, 0o700)
  const hasSkillsDirectory = yield* fs.exists(join(directory, 'skills'))
  const hasWorkflowsDirectory = yield* fs.exists(join(directory, 'workflows'))
  if (hasSkillsDirectory || hasWorkflowsDirectory) {
    return yield* new IntegrationError({ message: 'Incomplete Gmail assets directory. Move it aside before retrying installation.' })
  }
  if (!(yield* fs.exists(skillPath(source))) || !(yield* fs.exists(workflowPath(source)))) {
    return yield* new IntegrationError({ message: 'The bundled Gmail workflow is missing.' })
  }
  const staging = join(directory, '.gmail-assets-staging')
  yield* fs.remove(staging, { recursive: true, force: true })
  yield* fs.makeDirectory(join(staging, 'skills', skillName), { recursive: true, mode: 0o700 })
  yield* fs.makeDirectory(join(staging, 'workflows', 'gmail'), { recursive: true, mode: 0o700 })
  yield* fs.copy(skillPath(source), skillPath(staging))
  yield* fs.copy(workflowPath(source), workflowPath(staging))
  yield* fs.rename(join(staging, 'skills'), join(directory, 'skills')).pipe(Effect.uninterruptible)
  yield* fs.rename(join(staging, 'workflows'), join(directory, 'workflows')).pipe(Effect.uninterruptible)
  yield* fs.remove(staging, { recursive: true, force: true })
  if (!(yield* hasAssets(directory))) return yield* new IntegrationError({ message: 'The Gmail workflow could not be installed.' })
})

export const installedSkillPath = (directory: string) => skillPath(directory)
export const installedWorkflowPath = (directory: string) => workflowPath(directory)
