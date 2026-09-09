import { Context, Effect, FileSystem } from 'effect'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IntegrationError } from '../base/index.ts'

export const skillNames = ['lark-shared', 'lark-im', 'lark-mail'] as const

/** Source-tree default; Electron injects the unpacked bundled skills directory. */
export const LarkSkillsDirectory = Context.Reference<string>('@folio/integrations/lark/SkillsDirectory', {
  defaultValue: () => fileURLToPath(new URL('./assets/skills', import.meta.url))
})

/** Checks complete installed skill entrypoints without downloading or changing files. */
export const hasSkills = Effect.fn('Lark.hasSkills')(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  for (const name of skillNames) {
    if (!(yield* fs.exists(join(directory, 'skills', name, 'SKILL.md')))) return false
  }
  return true
})

/** Copies bundled skills after confirmation; stages complete trees before publication. */
export const installSkills = Effect.fn('Lark.installSkills')(function*(directory: string) {
  if (yield* hasSkills(directory)) return
  const fs = yield* FileSystem.FileSystem
  const source = yield* LarkSkillsDirectory
  const destination = join(directory, 'skills')
  if (yield* fs.exists(destination)) {
    return yield* new IntegrationError({ message: 'Incomplete skills directory. Move it aside before retrying installation.' })
  }
  if (!(yield* fs.exists(source))) return yield* new IntegrationError({ message: 'The bundled Lark skills are missing.' })
  const staging = join(directory, '.skills-staging')
  yield* fs.remove(staging, { recursive: true, force: true })
  yield* fs.makeDirectory(staging, { recursive: true, mode: 0o700 })
  for (const name of skillNames) {
    const skill = join(source, name)
    if (!(yield* fs.exists(join(skill, 'SKILL.md')))) {
      return yield* new IntegrationError({ message: `The bundled Lark skill is incomplete: ${name}.` })
    }
    yield* fs.copy(skill, join(staging, name))
  }
  const license = join(source, 'LICENSE')
  if (yield* fs.exists(license)) yield* fs.copy(license, join(staging, 'LICENSE'))
  for (const name of skillNames) {
    if (!(yield* fs.exists(join(staging, name, 'SKILL.md')))) {
      return yield* new IntegrationError({ message: `Bundled Lark skills are incomplete: ${name}.` })
    }
  }
  yield* fs.rename(staging, destination).pipe(Effect.uninterruptible)
})
