import { NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GmailAssetsDirectory, installAssets } from '../src/gmail/assets.ts'
import { ensureExtractor, LarkWorkflowsDirectory } from '../src/lark/workflows.ts'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'folio-bundled-assets-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('bundled asset upgrades', () => {
  it.each(['gmail', 'lark'] as const)('refreshes %s scripts and preserves credentials and unchanged files', async provider => {
    const directory = join(root, 'installed')
    const source = join(root, 'source')
    const workflow = provider === 'gmail' ? 'gmail' : 'lark-im'
    const sourceScript = provider === 'gmail' ? join(source, 'workflows', workflow) : join(source, workflow)
    const installedScript = join(directory, 'workflows', workflow, 'extract-window.mjs')
    await mkdir(sourceScript, { recursive: true })
    await writeFile(join(sourceScript, 'extract-window.mjs'), 'new extractor')
    await mkdir(join(directory, 'workflows', workflow), { recursive: true })
    await writeFile(installedScript, 'old extractor')
    await writeFile(join(directory, 'private.json'), 'private authorization')
    if (provider === 'gmail') {
      await mkdir(join(source, 'skills/gmail-mail'), { recursive: true })
      await writeFile(join(source, 'skills/gmail-mail/SKILL.md'), 'bundled skill')
    }
    const install = provider === 'gmail'
      ? installAssets(directory).pipe(Effect.provideService(GmailAssetsDirectory, source))
      : ensureExtractor(directory).pipe(Effect.provideService(LarkWorkflowsDirectory, source))
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
})
