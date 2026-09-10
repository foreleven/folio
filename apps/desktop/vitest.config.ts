import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/** Keep desktop tests on the same Agent source boundaries as the Electron main build. */
export default defineConfig({
  resolve: {
    alias: {
      '@folio/agent/config/schema': resolve('../../packages/agent/src/config/schema.ts'),
      '@folio/agent/config/directory': resolve('../../packages/agent/src/config/directory.ts'),
      '@folio/agent/config/loader': resolve('../../packages/agent/src/config/loader.ts'),
      '@folio/agent/model': resolve('../../packages/agent/src/model/index.ts')
    }
  }
})
