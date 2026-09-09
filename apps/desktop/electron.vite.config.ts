import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: {
      externalizeDeps: {
        // Compile the workspace's TypeScript, but let Node load the SDK so ws can
        // catch missing optional native dependencies (bufferutil/utf-8-validate).
        exclude: ['@folio/integrations'],
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
      dedupe: ['react', 'react-dom'],
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
