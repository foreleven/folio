import { Effect, FileSystem } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import { join } from 'node:path'
import { IntegrationError } from '../base/index.ts'

export const skillNames = ['lark-shared', 'lark-im', 'lark-mail'] as const
const revision = 'f065bf5b645af381f9b7475ce721451e6ca36a23'

/** Checks complete installed skill entrypoints without downloading or changing files. */
export const hasSkills = Effect.fn('Lark.hasSkills')(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  for (const name of skillNames) {
    if (!(yield* fs.exists(join(directory, 'skills', name, 'SKILL.md')))) return false
  }
  return true
})

/** Downloads pinned upstream skills after confirmation; stages complete trees before publication. */
export const installSkills = Effect.fn('Lark.installSkills')(function*(directory: string) {
  if (yield* hasSkills(directory)) return
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  // Do not overwrite a user's incomplete or modified installation.
  const destination = join(directory, 'skills')
  if (yield* fs.exists(destination)) {
    return yield* new IntegrationError({ message: 'Incomplete skills directory. Move it aside before retrying installation.' })
  }
  const temporary = yield* fs.makeTempDirectoryScoped({ directory, prefix: '.skills-' })
  const source = join(temporary, 'upstream')
  for (const args of [
    ['clone', '--depth', '1', '--branch', 'v1.0.94', 'https://github.com/larksuite/cli.git', source],
    ['-C', source, 'checkout', '--detach', revision]
  ]) {
    const code = yield* spawner.exitCode(ChildProcess.make('git', args, {
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore'
    }))
    if (code !== 0) return yield* new IntegrationError({ message: 'Could not download the pinned Lark skills.' })
  }
  const staged = join(temporary, 'skills')
  yield* fs.makeDirectory(staged)
  for (const name of skillNames) {
    yield* fs.copy(join(source, 'skills', name), join(staged, name))
  }
  yield* fs.copy(join(source, 'LICENSE'), join(staged, 'LICENSE'))
  if (!(yield* hasSkills(temporary))) {
    return yield* new IntegrationError({ message: 'Downloaded Lark skills are incomplete.' })
  }
  yield* fs.rename(staged, destination).pipe(Effect.uninterruptible)
}, Effect.scoped)
