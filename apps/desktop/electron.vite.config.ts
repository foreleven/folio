import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'electron-vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'agent-worker': resolve('src/main/workers/agent-worker.ts')
        }
      },
      externalizeDeps: {
        // These workspace packages expose TypeScript source rather than a
        // runtime build, so the main bundle must compile them in place.
        exclude: ['@folio/integrations', '@folio/agent'],
        // The SDK's ESM build references CommonJS `__dirname`; keep its
        // CommonJS entry external so Node supplies that global at runtime.
        include: ['@larksuiteoapi/node-sdk']
      }
    }
  },
  preload: {
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
      dedupe: ['react', 'react-dom']
    },
    plugins: [react(), tailwindcss()]
  }
})
