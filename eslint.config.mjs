import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { defineConfig } from 'eslint/config'

// Effect's current monorepo uses @effect/oxc with Oxlint. The older official
// @effect/eslint-plugin only adds formatting and no-barrel-import rules; the latter
// conflicts with this project's established `import { Effect } from 'effect'` style.
// Keep Effect-specific rules out until a dedicated import migration is desired.

/** Keep the initial rollout informative: recommended diagnostics warn instead of blocking existing code. */
function warningsOnly(config) {
  return {
    ...config,
    rules: Object.fromEntries(
      Object.entries(config.rules ?? {}).map(([name, setting]) => {
        if (setting === 0 || setting === 'off') return [name, 'off']
        return [name, Array.isArray(setting) ? ['warn', ...setting.slice(1)] : 'warn']
      })
    )
  }
}

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/out/**',
      '**/dist/**',
      '**/coverage/**',
      '**/*.d.ts',
      '**/*.tsbuildinfo',
      'repos/**',
      'packages/integrations/src/lark/assets/**'
    ]
  },
  {
    ...js.configs.recommended,
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      }
    }
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{tsx,jsx}'],
    plugins: {
      'react-hooks': reactHooks
    },
    rules: warningsOnly(reactHooks.configs.flat.recommended).rules
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_'
        }
      ]
    }
  },
  prettier
)
