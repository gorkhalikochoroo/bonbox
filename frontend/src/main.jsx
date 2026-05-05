import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
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
