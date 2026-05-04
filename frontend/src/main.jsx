import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { applyThemeImmediately } from './hooks/useTheme.jsx'

// Apply saved theme to <html> BEFORE React mounts so the user never sees
// the wrong-color flash while React boots.
applyThemeImmediately()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
