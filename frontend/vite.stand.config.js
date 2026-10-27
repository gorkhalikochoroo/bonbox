// The door screen's own build (R11, rubric B11): stand.html → src/stand/.
// Runs after the app's build (`npm run build`), into the same dist/ and the
// same /assets/ (hashed names: identical code is the same file, so a device
// that has the app cached has e.g. vendor-react already). See
// scripts/standBuild.mjs for why the door screen is built on its own.
//
// __STAND_BUILD__ is true here and false in the app's build (and in vitest):
// ReservationsPage's owner-only tabs and cards sit behind it, so this build
// drops them while the owner app is unchanged.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import app from './vite.config.js'
import { standBudget, standModules, standWords } from './scripts/standBuild.mjs'

export default defineConfig({
  plugins: [react(), standModules(), standWords(), standBudget()],
  esbuild: app.esbuild,
  define: { ...app.define, __STAND_BUILD__: 'true' },
  resolve: app.resolve,
  // public/ is the app build's to copy; this build adds stand.html and its
  // chunks next to it and removes nothing.
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    modulePreload: app.build.modulePreload,
    rollupOptions: {
      input: { stand: fileURLToPath(new URL('./stand.html', import.meta.url)) },
      output: app.build.rollupOptions.output,
      // Only stylesheets are imported for their side effects in the door
      // screen's code (src/stand/main.jsx — tests/r11.standBuild checks it).
      // So a module whose exports go unused here is dropped whole — e.g. the
      // QR library the owner's website kit imports at the top of a file this
      // build only uses a part of.
      treeshake: { moduleSideEffects: (id) => /\.css($|\?)/.test(id) },
    },
    chunkSizeWarningLimit: app.build.chunkSizeWarningLimit,
  },
})
