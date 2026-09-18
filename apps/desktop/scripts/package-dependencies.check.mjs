import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder'))
const { PnpmNodeModulesCollector } = builderRequire('app-builder-lib/out/node-module-collector/pnpmNodeModulesCollector.js')

// pnpm expands a shared package differently in separate branches. The second
// branch can own the only full description of a transitive dependency.
test('collects descendants of repeated pnpm packages before resolving deduped references', async () => {
  const collector = new PnpmNodeModulesCollector('/app', {})
  collector.locateFromDepOrRoot = async (name, path) => ({ packageDir: path })
  const leaf = { version: '1.0.0', path: '/store/leaf' }
  const first = {
    version: '1.0.0', path: '/store/shared',
    dependencies: { leaf: { ...leaf, dedupedDependenciesCount: 1 } }
  }
  const second = { ...first, dependencies: { leaf } }
  const branch = dependencies => ({ version: '1.0.0', path: '/store/branch', dependencies })
  const tree = { dependencies: {
    first: branch({ shared: first }),
    second: branch({ shared: second })
  } }
  await collector.collectDepsRecursively(tree)
  assert.equal(collector.allDependencies.get('leaf@1.0.0')?.path, '/store/leaf')
  await collector.extractProductionDependencyGraph(tree, 'app')
  assert.deepEqual(collector.productionGraph['shared@1.0.0'].dependencies, ['leaf@1.0.0'])
  assert.deepEqual(collector.productionGraph['leaf@1.0.0'].dependencies, [])
})

test('resolves deduped npm aliases using the physical package while retaining the alias', async () => {
  const collector = new PnpmNodeModulesCollector('/app', {})
  // The resolver may return an alias symlink rather than pnpm's reported path.
  collector.locateFromDepOrRoot = async (name, path) => ({ packageDir: name === 'original' ? '/aliases/original' : path })
  const original = { version: '1.0.0', path: '/store/original', dependencies: {
    leaf: { version: '1.0.0', path: '/store/leaf' }
  } }
  const tree = { dependencies: {
    alias: { version: '1.0.0', path: original.path, dedupedDependenciesCount: 1 },
    original
  } }
  await collector.collectDepsRecursively(tree)
  await collector.extractProductionDependencyGraph(tree, 'app')
  assert.equal(collector.allDependencies.get('alias@1.0.0')?.path, '/aliases/original')
  assert.deepEqual(collector.productionGraph['alias@1.0.0'].dependencies, ['leaf@1.0.0'])
})
