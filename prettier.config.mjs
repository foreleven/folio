export default {
  semi: false,
  singleQuote: true,
  trailingComma: 'none',
  printWidth: 180,
  tabWidth: 2,
  useTabs: false,
  arrowParens: 'always',
  overrides: [
    {
      files: ['packages/ui/src/components/ui/**/*.{ts,tsx}', 'packages/ui/components.json'],
      options: {
        singleQuote: false,
        trailingComma: 'es5'
      }
    }
  ]
}
