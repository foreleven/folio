import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

/** Keep desktop tests on the same Agent source boundaries as the Electron main build. */
export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom', 'effect']
  }
})
