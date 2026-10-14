/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// ── The landing's boot dictionary (push 9, E) ─────────────────────
// `virtual:bonbox-boot-dict` = { da: {...}, en: {...} } holding only the keys
// src/lib/bootKeys.js accepts (the landing page and the cookie banner),
// generated from src/i18n/da.js and en.js — those two stay the only place a
// string is written. hooks/useLanguage.jsx renders the landing with it while
// the full dictionary (~185 KB gz) is still on its way. ~13 KB gz for both.
// Runs in dev, build and vitest alike, so a test sees what production ships.
function bootDictionary() {
  const VID = 'virtual:bonbox-boot-dict'
  const RID = '\0' + VID
  const file = (f) => new URL(f, import.meta.url)
  return {
    name: 'bonbox-boot-dictionary',
    resolveId(id) {
      if (id === VID) return RID
    },
    async load(id) {
      if (id !== RID) return
      const files = ['./src/lib/bootKeys.js', './src/i18n/da.js', './src/i18n/en.js']
      for (const f of files) this.addWatchFile(fileURLToPath(file(f)))
      // ?t= busts Node's module cache so dev picks up an edited dictionary.
      const stamp = Date.now()
      const load = (f) => import(file(f).href + '?t=' + stamp)
      const [{ isBootKey }, { da }, { en }] = await Promise.all(files.map(load))
      const pick = (d) => Object.fromEntries(Object.entries(d).filter(([k]) => isBootKey(k)))
      return `export default ${JSON.stringify({ da: pick(da), en: pick(en) })};`
    },
  }
}

// ── Start the visitor's dictionary download with the page ─────────
// The English and Danish dictionaries are their own chunks, loaded on
// demand (src/lib/localeStore.js) so a visitor downloads one, not both.
// Left to the dynamic import, that download would only START once the whole
// app bundle had arrived and run — a second, serial wait before first paint.
// This writes a tiny script into index.html that picks the likely language
// (the stored choice, else the browser's) and adds a modulepreload for that
// dictionary, so it downloads alongside the app. A wrong guess costs one
// spare download, never a wrong page: the loader still decides.
function preloadDictionary() {
  return {
    name: 'bonbox-preload-dictionary',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const files = {}
        for (const chunk of Object.values(ctx.bundle || {})) {
          const m = chunk.type === 'chunk' && chunk.facadeModuleId &&
            chunk.facadeModuleId.match(/[\\/]src[\\/]i18n[\\/](en|da)\.js$/)
          if (m) files[m[1]] = '/' + chunk.fileName
        }
        if (!files.en || !files.da) return html
        // Push 9 (E): NOT on the landing ("/" or "/v2") for a visitor with
        // no session — that page paints from the boot dictionary, and a
        // 185 KB preload there only competes with the app code and fonts the
        // first paint is waiting for. The dictionary still loads, right after
        // the first paint (hooks/useLanguage.jsx). Same test as
        // src/lib/landingBoot.js: the bonbox_csrf cookie or a native token.
        const script =
          '<script>(function(){try{' +
          'var p=location.pathname.replace(/\\/+$/,"")||"/";' +
          'if((p==="/"||p==="/v2")&&!/(?:^|;\\s*)bonbox_csrf=/.test(document.cookie)){var tk=null;try{tk=localStorage.getItem("token")}catch(e){}if(!tk)return}' +
          `var f=${JSON.stringify(files)};` +
          'var l=null;try{l=localStorage.getItem("lang")}catch(e){}' +
          'if(!l){var n=(navigator.languages||[navigator.language||""]).join(",").toLowerCase();l=/(^|,)(da|fo)/.test(n)?"da":"en"}' +
          'var h=l==="da"?f.da:f.en;' +
          'var k=document.createElement("link");k.rel="modulepreload";k.href=h;document.head.appendChild(k)' +
          '}catch(e){}})()</script>'
        return html.replace('</head>', script + '</head>')
      },
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), preloadDictionary(), bootDictionary()],
  // Force the automatic JSX runtime everywhere — production already
  // uses it via @vitejs/plugin-react, but vitest's transform pipeline
  // sometimes falls back to the classic runtime which requires
  // `import React from 'react'` in every .jsx file. Setting it here
  // keeps test + production behaviour aligned without polluting source
  // files with classic-runtime boilerplate.
  esbuild: {
    jsx: 'automatic',
  },
  // ── Build stamp for the client-error beacon ──────────────────────
  // Injected as a literal so a crashing browser can report WHICH build
  // it was running. On Vercel this is the deploy commit SHA; a report
  // whose build_id != the current server build = a stale/skewed deploy
  // (exactly the ReservationsPage chunk-mismatch class we're hunting).
  define: {
    __BUILD_ID__: JSON.stringify(
      (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 8) ||
      ('t' + Date.now().toString(36))
    ),
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
    // Trim the startup modulepreload list.
    //
    // index.html was emitting 52 <link rel="modulepreload">, including
    // vendor-charts (402 KB of recharts + d3). A transitive scan of the STATIC
    // import graph from App.jsx (44 modules) shows nothing eager imports
    // recharts — every page that charts is behind a lazy route. So the browser
    // was fetching and COMPILING 402 KB at launch for code the first screen
    // never touches. On a Capacitor build the fetch is a disk read, but the
    // compile is real work on the critical path, and cold open measured 4-5s
    // to content.
    //
    // Dropping it from the preload list changes nothing about correctness:
    // whichever lazy route needs charts still imports them normally, one beat
    // later. vendor-i18n is deliberately NOT trimmed — LanguageProvider is
    // eager in App.jsx and every string on the first screen depends on it.
    modulePreload: {
      resolveDependencies: (_file, deps) =>
        deps.filter((d) => !d.includes("vendor-charts")),
    },
    rollupOptions: {
      output: {
        // Push 6 (B4) — React out of vendor-charts. With manualChunks under
        // Vite 8 (rolldown), part of React (its shared client internals)
        // landed in the vendor-charts chunk, which the entry, vendor-react
        // and vendor-i18n then imported statically — so every first page,
        // /register and /login included, fetched and compiled recharts + d3
        // (411 KB raw) just to start React, and the modulePreload filter
        // below only delayed it.
        // codeSplitting groups with priorities keep each vendor in its own
        // chunk: React first, then the i18n provider, motion, and charts
        // only for the lazy pages that chart. Measured on a local A/B
        // (3 runs, cold cache): the entry's static closure 285.8 → 175.1 KB
        // gz; form usable on /register at 400 kbps / 400 ms / 4x CPU
        // 13.26 → 10.91 s, at 1.6 Mbps / 150 ms 3.57 → 3.00 s.
        //
        // The /i18n/*.js dictionaries stay out of every group: each is its
        // own chunk, loaded on demand (lib/localeStore.js).
        codeSplitting: {
          groups: [
            { name: 'vendor-react', test: /node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/, priority: 40 },
            { name: 'vendor-i18n', test: /[\\/]hooks[\\/]useLanguage/, priority: 30 },
            { name: 'vendor-motion', test: /node_modules[\\/]framer-motion[\\/]/, priority: 20 },
            { name: 'vendor-charts', test: /node_modules[\\/](recharts|d3-[^\\/]+)[\\/]/, priority: 10 },
          ],
        },
      },
    },
    // Increase warning threshold (Capacitor adds size)
    chunkSizeWarningLimit: 600,
  },
})
