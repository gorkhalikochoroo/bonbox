import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Build output and the native shells (their public/ folders are copies of
  // the built bundle) — generated code, never hand-written.
  globalIgnores(['dist', 'dist-*', 'coverage', 'ios', 'ios-scheduler', 'android']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
      // Native alert() is banned (components/ui/index.js:26) — use toast()
      // from hooks/useToast, or useConfirm() when you need an answer back.
      // Scoped to `alert` deliberately: the blanket `no-alert` rule also bans
      // confirm(), which would flag useConfirm.jsx's documented no-provider
      // fallback — the safety net that stops a stray import crashing a screen.
      'no-restricted-globals': [
        'error',
        { name: 'alert', message: 'Use toast() from hooks/useToast (see components/ui/index.js:26).' },
      ],
    },
  },
  // Build config and repo scripts run in Node, not the browser.
  {
    files: ['*.config.js', 'scripts/**/*.{js,cjs,mjs}'],
    languageOptions: { globals: globals.node },
  },
])
