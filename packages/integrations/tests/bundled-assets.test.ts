import { NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installSkills, LarkSkillsDirectory } from '../src/lark/skills.ts'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'folio-bundled-assets-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('bundled asset upgrades', () => {
  it('installs the generic Lark Skills without touching credentials', async () => {
    const directory = join(root, 'installed')
    const source = join(root, 'source')
    for (const name of ['lark-shared', 'lark-im', 'lark-mail']) {
      await mkdir(join(source, name), { recursive: true })
      await writeFile(join(source, name, 'SKILL.md'), `${name} bundled`)
    }
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'private.json'), 'private authorization')

    const run = () => Effect.runPromise(installSkills(directory).pipe(
      Effect.provideService(LarkSkillsDirectory, source), Effect.provide(NodeServices.layer)))
    await run()
    expect(await readFile(join(directory, 'skills/lark-im/SKILL.md'), 'utf8')).toBe('lark-im bundled')
    expect(await readFile(join(directory, 'private.json'), 'utf8')).toBe('private authorization')
    const before = await stat(join(directory, 'skills/lark-im/SKILL.md'))
    await run()
    expect((await stat(join(directory, 'skills/lark-im/SKILL.md'))).mtimeMs).toBe(before.mtimeMs)
  })
})
