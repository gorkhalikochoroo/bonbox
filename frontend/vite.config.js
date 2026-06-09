/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Force the automatic JSX runtime everywhere — production already
  // uses it via @vitejs/plugin-react, but vitest's transform pipeline
  // sometimes falls back to the classic runtime which requires
  // `import React from 'react'` in every .jsx file. Setting it here
  // keeps test + production behaviour aligned without polluting source
  // files with classic-runtime boilerplate.
  esbuild: {
    jsx: 'automatic',
  },
  // ── Single React instance (guards "Invalid hook call") ───────────
  // React's hook dispatcher is module-level state: if any dependency
  // resolves a SECOND copy of react/react-dom, every hook in the app
  // throws "Invalid hook call … more than one copy of React" and the
  // whole authed tree fails to mount. This happens in dev when the
  // pre-bundler optimizes a large interop dep (e.g. an optional
  // @sentry/react) into its own chunk that doesn't share the app's
  // React. `dedupe` forces every `react`/`react-dom` import to the one
  // physical copy; `optimizeDeps.include` keeps them in a single
  // pre-bundled instance so dev matches the production single-vendor
  // build. Both are no-ops once there's only one copy — safe to keep.
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
  },
  // ── Vitest test config (May 2026) ────────────────────────────────
  // We deliberately keep the test runner inside the existing Vite
  // config (rather than a separate vitest.config.js) so the test
  // environment uses the SAME plugin pipeline as production builds.
  // That means a regression in plugin behaviour (e.g. JSX transform
  // changes) shows up in tests + builds together — no drift.
  //
  // Why these specific settings:
  //   • environment: 'jsdom'    — DOM APIs needed for React component
  //                               rendering. happy-dom is faster but
  //                               jsdom matches browser more closely
  //                               (better for security-relevant tests
  //                               of safeImageUrl + Locked overlay).
  //   • setupFiles              — registers @testing-library/jest-dom
  //                               matchers (toBeInTheDocument, etc.)
  //                               + auto-cleanup between tests.
  //   • globals: true           — `describe`/`it`/`expect` available
  //                               without imports — matches Jest mental
  //                               model the team is more familiar with.
  //   • include                 — ONLY look in src/__tests__ + co-
  //                               located *.test.{js,jsx}. No tests
  //                               under node_modules or coverage.
  //   • css: false              — skip CSS processing in test env;
  //                               unit tests don't depend on Tailwind
  //                               class output, just on rendered DOM.
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    include: [
      'src/**/*.{test,spec}.{js,jsx}',
      'src/__tests__/**/*.{js,jsx}',
    ],
    css: false,
    // Coverage left un-configured (no coverage tool installed by
    // default). When we add v8 coverage later, we'll set thresholds
    // here so a regression in hook coverage fails CI.
  },
  build: {
    // Code splitting — separate vendor + i18n chunks for better caching.
    // Each chunk is a separate file in /assets so the browser can
    // cache them independently — bumping the app code doesn't
    // invalidate the 200KB+ vendor bundles or the translation strings.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/') || id.includes('node_modules/react-router')) return 'vendor-react';
          if (id.includes('node_modules/recharts') || id.includes('node_modules/d3-')) return 'vendor-charts';
          if (id.includes('node_modules/framer-motion')) return 'vendor-motion';
          // useLanguage.jsx contains the EN + DA dicts inline plus the
          // LanguageProvider. The /i18n/*.js locale files are loaded
          // dynamically via LAZY_LOADERS — vite turns each into its
          // own chunk automatically when the dynamic import() runs,
          // so we deliberately exclude them from the manualChunks
          // rule. Bundling them here would re-merge them into
          // vendor-i18n and erase the ~600 KB savings on initial
          // paint (the lazy-loading change in this commit).
          //
          // Result:
          //   vendor-i18n  — useLanguage.jsx + EN + DA (~150 KB)
          //   de.js / fr.js / etc. — separate chunks loaded on demand
          if (id.includes('/hooks/useLanguage')) return 'vendor-i18n';
        },
      },
    },
    // Increase warning threshold (Capacitor adds size)
    chunkSizeWarningLimit: 600,
  },
})
