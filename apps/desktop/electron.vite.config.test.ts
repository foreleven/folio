import { describe, expect, it } from 'vitest'
import config from './electron.vite.config'

describe('Electron Vite configuration', () => {
  it('builds the sandboxed preload as an executable CommonJS entry', () => {
    expect(config.preload).toMatchObject({
      build: {
        rollupOptions: {
          output: {
            format: 'cjs',
            entryFileNames: '[name].cjs'
          }
        }
      }
    })
  })
})
