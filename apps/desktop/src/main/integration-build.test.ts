import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { resolveConfig } from 'electron-vite'
import { build } from 'vite'
import { expect, it, vi } from 'vitest'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('../..', import.meta.url))

// Execute the generated code outside Vitest's module loader: ordinary source tests
// cannot detect Vite hoisting ws's optional dependency failures out of try/catch.
it.each(['development', 'production'] as const)('loads the integration bundle in %s', async (mode) => {
  const directory = await mkdtemp(join(root, '.integration-build-'))
  vi.stubEnv('NODE_ENV', mode)
  try {
    const entry = join(directory, 'entry.ts')
    await writeFile(entry, "export { lark } from '@folio/integrations'\n")
    const { config } = await resolveConfig({ root, configFile: join(root, 'electron.vite.config.ts'), logLevel: 'silent' },
      mode === 'development' ? 'serve' : 'build', mode)
    if (!config?.main) throw new Error('Missing Electron main configuration')
    await build({
      ...config.main, configFile: false, logLevel: 'silent',
      build: {
        ...config.main.build, outDir: join(directory, 'out'),
        lib: { entry, formats: ['es'] },
        rollupOptions: { output: { entryFileNames: 'index.mjs' } }
      }
    })
    const url = pathToFileURL(join(directory, 'out/index.mjs')).href
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e',
      `const { lark } = await import(${JSON.stringify(url)}); console.log(lark.id)`])
    expect(stdout.trim()).toBe('lark')
  } finally {
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
