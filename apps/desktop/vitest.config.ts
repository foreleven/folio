import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

/** Keep desktop tests on the same Agent source boundaries as the Electron main build. */
export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom', 'effect'],
    alias: {
      '@folio/agent/config/schema': resolve('../../packages/agent/src/config/schema.ts'),
      '@folio/agent/config/directory': resolve('../../packages/agent/src/config/directory.ts'),
      '@folio/agent/config/loader': resolve('../../packages/agent/src/config/loader.ts'),
      '@folio/agent/model': resolve('../../packages/agent/src/model/index.ts')
    }
  }
})
