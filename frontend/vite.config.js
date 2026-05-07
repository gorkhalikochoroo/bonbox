import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
