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
