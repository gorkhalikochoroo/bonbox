# ADR-002: Custom i18n hook instead of i18next

## Status: Accepted

## Context
Needed trilingual support (EN/DA/NP) without heavy library overhead.

## Decision
Built custom `useLanguage()` hook with a translations object and `t(key)` function. Language stored in localStorage, provided via React Context.

## Consequences
- Lightweight, no extra dependencies
- All translations in one file (useLanguage.jsx)
- Easy to add new languages (add code to LANGUAGES array + translations)
- No pluralization or interpolation features (not needed yet)

## Update — September 2026
- The dictionaries moved out of useLanguage.jsx into one file per language
  (`src/i18n/en.js`, `src/i18n/da.js`, …). `src/lib/localeStore.js` loads
  only the language in use, so a visit downloads one dictionary, not all of
  them. The hook and `t(key, fallback, vars)` are unchanged (`vars` fills
  `{name}` placeholders).
