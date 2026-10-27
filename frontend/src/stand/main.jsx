// The door screen's entry (R11, rubric B11) — stand.html loads this, never
// src/main.jsx. The same fonts, stylesheet and theme as the app, so the book
// looks exactly as it does inside it; only the code around it is smaller
// (see StandApp.jsx and scripts/standBuild.mjs).
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Inter, the latin file per weight the book uses (main.jsx explains the
// subset rule); extended Latin on demand for guest names like Łukasz.
import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-600.css'
import '@fontsource/inter/latin-700.css'
import '../fonts-ext-subsets.css'

import '../index.css'
import { applyThemeImmediately } from '../hooks/useTheme.jsx'
import StandApp from './StandApp.jsx'

applyThemeImmediately()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <StandApp />
  </StrictMode>,
)
