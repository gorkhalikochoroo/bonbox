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
          // useLanguage.jsx is ~3500 lines of translation strings + the
          // /i18n/ folder has 12 locale files. Bundling them into their
          // own chunk (rather than inlined into index.js) means the
          // strings load in parallel with the main bundle and stay
          // cached across app-code redeploys (which are far more
          // frequent than translation changes).
          if (id.includes('/hooks/useLanguage') || id.includes('/i18n/')) return 'vendor-i18n';
        },
      },
    },
    // Increase warning threshold (Capacitor adds size)
    chunkSizeWarningLimit: 600,
  },
})
