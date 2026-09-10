import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@folio/agent/config/schema': resolve('../../packages/agent/src/config/schema.ts'),
        '@folio/agent/config/directory': resolve('../../packages/agent/src/config/directory.ts'),
        '@folio/agent/config/loader': resolve('../../packages/agent/src/config/loader.ts'),
        '@folio/agent/model': resolve('../../packages/agent/src/model/index.ts')
      }
    },
    build: {
      externalizeDeps: {
        // Compile the workspace's TypeScript, but let Node load the SDK so ws can
        // catch missing optional native dependencies (bufferutil/utf-8-validate).
        exclude: ['@folio/integrations', '@folio/agent'],
        include: ['@larksuiteoapi/node-sdk', '@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', 'proper-lockfile']
      }
    }
  },
  preload: {
    resolve: {
      alias: {
        '@folio/agent/config/schema': resolve('../../packages/agent/src/config/schema.ts')
      }
    },
    build: {
      rollupOptions: {
        // Sandboxed Electron preloads execute as CommonJS rather than native ESM.
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    resolve: {
      // Workspace UI dependencies must share the renderer's React dispatcher.
      dedupe: ['react', 'react-dom'],
      alias: {
        '@folio/agent/config/schema': resolve('../../packages/agent/src/config/schema.ts'),
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
