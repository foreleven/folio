import { NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GmailAssetsDirectory, installAssets } from '../src/gmail/assets.ts'
import { ImapAssetsDirectory, installAssets as installImapAssets } from '../src/imap/assets.ts'
import { installSkills, LarkSkillsDirectory } from '../src/lark/skills.ts'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'folio-bundled-assets-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('bundled asset upgrades', () => {
  it.each(['gmail', 'imap'] as const)('refreshes %s scripts and preserves credentials and unchanged files', async provider => {
    const directory = join(root, 'installed')
    const source = join(root, 'source')
    const workflow = provider
    const sourceScript = join(source, 'workflows', workflow)
    const installedScript = join(directory, 'workflows', workflow, 'extract-window.mjs')
    await mkdir(sourceScript, { recursive: true })
    await writeFile(join(sourceScript, 'extract-window.mjs'), 'new extractor')
    await mkdir(join(directory, 'workflows', workflow), { recursive: true })
    await writeFile(installedScript, 'old extractor')
    await writeFile(join(directory, 'private.json'), 'private authorization')
    await mkdir(join(source, `skills/${provider}-mail`), { recursive: true })
    await writeFile(join(source, `skills/${provider}-mail/SKILL.md`), 'bundled skill')
    const install = provider === 'gmail'
      ? installAssets(directory).pipe(Effect.provideService(GmailAssetsDirectory, source))
      : installImapAssets(directory).pipe(Effect.provideService(ImapAssetsDirectory, source))
    const run = () => Effect.runPromise(install.pipe(Effect.provide(NodeServices.layer)))
    await run()
    expect(await readFile(installedScript, 'utf8')).toBe('new extractor')
    expect(await readFile(join(directory, 'private.json'), 'utf8')).toBe('private authorization')
    const before = await stat(installedScript)
    await run()
    expect((await stat(installedScript)).mtimeMs).toBe(before.mtimeMs)
    await rm(join(sourceScript, 'extract-window.mjs'))
    await expect(run()).rejects.toThrow('missing')
    expect(await readFile(installedScript, 'utf8')).toBe('new extractor')
  })

  it('refreshes the self-contained Lark IM Skill without touching credentials or upstream Skills', async () => {
    const directory = join(root, 'installed')
    const source = join(root, 'source')
    const relativeScript = 'skills/folio-lark-im/scripts/extract-window.mjs'
    for (const name of ['lark-shared', 'lark-mail']) {
      await mkdir(join(directory, 'skills', name), { recursive: true })
      await writeFile(join(directory, 'skills', name, 'SKILL.md'), `${name} installed`)
    }
    await mkdir(join(source, 'folio-lark-im/scripts'), { recursive: true })
    await writeFile(join(source, 'folio-lark-im/SKILL.md'), 'new Folio IM Skill')
    await writeFile(join(source, 'folio-lark-im/scripts/extract-window.mjs'), 'new extractor')
    await mkdir(join(directory, 'skills/folio-lark-im/scripts'), { recursive: true })
    await writeFile(join(directory, 'skills/folio-lark-im/SKILL.md'), 'old Folio IM Skill')
    await writeFile(join(directory, relativeScript), 'old extractor')
    await writeFile(join(directory, 'private.json'), 'private authorization')

    const run = () => Effect.runPromise(installSkills(directory).pipe(
      Effect.provideService(LarkSkillsDirectory, source), Effect.provide(NodeServices.layer)))
    await run()
    expect(await readFile(join(directory, relativeScript), 'utf8')).toBe('new extractor')
    expect(await readFile(join(directory, 'skills/folio-lark-im/SKILL.md'), 'utf8')).toBe('new Folio IM Skill')
    expect(await readFile(join(directory, 'skills/lark-shared/SKILL.md'), 'utf8')).toBe('lark-shared installed')
    expect(await readFile(join(directory, 'private.json'), 'utf8')).toBe('private authorization')
    const before = await stat(join(directory, relativeScript))
    await run()
    expect((await stat(join(directory, relativeScript))).mtimeMs).toBe(before.mtimeMs)
    await rm(join(source, 'folio-lark-im/scripts/extract-window.mjs'))
    await expect(run()).rejects.toThrow('incomplete')
    expect(await readFile(join(directory, relativeScript), 'utf8')).toBe('new extractor')
  })
})
