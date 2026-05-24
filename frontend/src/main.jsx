import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Self-host Inter (2026-05-24) — replaced the Google Fonts CDN <link>
// in index.html. Three reasons:
//   1. fonts.googleapis.com returned 503 on bonbox.dk during testing,
//      blocking first paint until the CSS request timed out.
//   2. The Vercel CSP didn't whitelist fonts.googleapis.com in style-src
//      anyway, so the CDN load was probably silently CSP-blocked.
//   3. Self-hosted assets ride the immutable /assets/* cache header
//      Vercel rewrites set (max-age=31536000), so font fetches now
//      happen at the same speed as the JS bundle and are subject to
//      the same trust boundary.
// Five weights to match the original Google Fonts request — 400 body,
// 500 medium UI labels, 600 buttons + section headings, 700 H2/H1,
// 800 hero. Each weight is ~15-20 KB woff2 = ~80 KB total, but cached
// immutably so the cost is paid once per build hash.
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/inter/800.css'

import './index.css'
import App from './App.jsx'
import { applyThemeImmediately } from './hooks/useTheme.jsx'

// Apply saved theme to <html> BEFORE React mounts so the user never sees
// the wrong-color flash while React boots.
applyThemeImmediately()

// Optional Sentry init — runs only when both VITE_SENTRY_DSN env var is
// set AND the @sentry/react package is installed. Wrapped in dynamic import
// so missing dep never crashes the app boot. Add the package + env var when
// you're ready to enable error tracking.
const _SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN
if (_SENTRY_DSN) {
  import('@sentry/react').then((Sentry) => {
    try {
      Sentry.init({
        dsn: _SENTRY_DSN,
        tracesSampleRate: 0.05,        // 5% transactions — cheap quota
        replaysSessionSampleRate: 0,   // disabled by default (privacy)
        replaysOnErrorSampleRate: 0.1, // record 10% of sessions that hit an error
        environment: import.meta.env.MODE,
        sendDefaultPii: false,
      })
    } catch (e) { /* never let Sentry init crash the app */ }
  }).catch(() => { /* @sentry/react not installed — silent */ })
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
