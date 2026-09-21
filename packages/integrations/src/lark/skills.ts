import { Context, Effect, FileSystem } from 'effect'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IntegrationError } from '../base/index.ts'

export const skillNames = ['folio-lark-im', 'lark-shared', 'lark-mail'] as const
const upstreamSkillNames = ['lark-shared', 'lark-mail'] as const
const folioImFiles = ['SKILL.md', 'scripts/extract-window.mjs'] as const

/** Source-tree default; Electron injects the unpacked bundled skills directory. */
export const LarkSkillsDirectory = Context.Reference<string>('@folio/integrations/lark/SkillsDirectory', {
  defaultValue: () => fileURLToPath(new URL('./assets/skills', import.meta.url))
})

/** Checks complete installed skill entrypoints without downloading or changing files. */
export const hasSkills = Effect.fn('Lark.hasSkills')(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  for (const name of skillNames) {
    if (!(yield* fs.exists(join(directory, 'skills', name, 'SKILL.md')))) {
      yield* Effect.logDebug('Lark skills installation is incomplete').pipe(
        Effect.annotateLogs({ missingSkill: name })
      )
      return false
    }
  }
  if (!(yield* fs.exists(join(directory, 'skills', 'folio-lark-im', 'scripts', 'extract-window.mjs')))) return false
  yield* Effect.logDebug('Lark skills installation found').pipe(Effect.annotateLogs({ skillCount: skillNames.length }))
  return true
}, Effect.annotateLogs({ integration: 'lark', subsystem: 'skills' }))

/** Refreshes the Folio-owned Skill in place so existing integrations follow app upgrades. */
const refreshFolioImSkill = Effect.fn('Lark.refreshFolioImSkill')(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  const source = join(yield* LarkSkillsDirectory, 'folio-lark-im')
  const installed = join(directory, 'skills', 'folio-lark-im')
  let changed = false
  for (const relative of folioImFiles) {
    if (!(yield* fs.exists(join(source, relative)))) {
      return yield* new IntegrationError({ message: `The bundled Lark IM Skill is incomplete: ${relative}.` })
    }
    const bundled = yield* fs.readFileString(join(source, relative))
    const current = yield* fs.readFileString(join(installed, relative)).pipe(
      Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed(undefined)))
    if (current !== bundled) changed = true
  }
  if (!changed) return
  const staging = yield* fs.makeTempDirectoryScoped({ directory, prefix: '.folio-lark-im-' })
  const next = join(staging, 'next')
  const previous = join(staging, 'previous')
  yield* fs.copy(source, next)
  yield* fs.makeDirectory(dirname(installed), { recursive: true, mode: 0o700 })
  let previousMoved = false
  yield* Effect.gen(function* () {
    if (yield* fs.exists(installed)) {
      yield* fs.rename(installed, previous)
      previousMoved = true
    }
    yield* fs.rename(next, installed)
    previousMoved = false
    yield* fs.remove(previous, { recursive: true, force: true })
  }).pipe(
    Effect.uninterruptible,
    Effect.catch(error => previousMoved
      ? fs.rename(previous, installed).pipe(Effect.andThen(Effect.fail(error)))
      : Effect.fail(error))
  )
}, Effect.scoped)

/** Copies bundled skills after confirmation; stages complete trees before publication. */
export const installSkills = Effect.fn('Lark.installSkills')(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  const source = yield* LarkSkillsDirectory
  const destination = join(directory, 'skills')
  if (yield* fs.exists(destination)) {
    for (const name of upstreamSkillNames) {
      if (!(yield* fs.exists(join(destination, name, 'SKILL.md')))) {
        return yield* new IntegrationError({ message: 'Incomplete skills directory. Move it aside before retrying installation.' })
      }
    }
    yield* refreshFolioImSkill(directory)
  }
  if (yield* hasSkills(directory)) {
    yield* Effect.logDebug('Reusing installed Lark skills')
    return
  }
  yield* Effect.logInfo('Lark skills installation started').pipe(Effect.annotateLogs({ skillCount: skillNames.length }))
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
    yield* Effect.logDebug('Bundled Lark skill staged').pipe(Effect.annotateLogs({ skill: name }))
  }
  const license = join(source, 'LICENSE')
  if (yield* fs.exists(license)) yield* fs.copy(license, join(staging, 'LICENSE'))
  for (const name of skillNames) {
    if (!(yield* fs.exists(join(staging, name, 'SKILL.md')))) {
      return yield* new IntegrationError({ message: `Bundled Lark skills are incomplete: ${name}.` })
    }
  }
  yield* fs.rename(staging, destination).pipe(Effect.uninterruptible)
  yield* Effect.logInfo('Lark skills installation completed').pipe(Effect.annotateLogs({ skillCount: skillNames.length }))
}, Effect.tapError(() => Effect.logError('Lark skills installation failed')),
Effect.annotateLogs({ integration: 'lark', subsystem: 'skills' }), Effect.withLogSpan('lark.installSkills'))
