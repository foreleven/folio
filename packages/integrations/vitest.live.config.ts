import { defineConfig } from 'vitest/config'

// Only explicit live-test commands enable network access and interactive setup.
export default defineConfig({
  test: {
    include: ['tests/install-lark.test.ts', 'tests/verify-lark.test.ts'],
    env: { FOLIO_LARK_LIVE: '1' },
    fileParallelism: false,
    disableConsoleIntercept: true
  }
})
