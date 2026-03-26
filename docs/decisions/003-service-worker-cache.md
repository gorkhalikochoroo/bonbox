# ADR-003: Service Worker cache versioning

## Status: Accepted

## Context
Nepal users were getting white screens due to stale cached bundles after code-splitting was introduced.

## Decision
- Version cache as `bonbox-v3`
- Auto-clear all caches in ErrorBoundary on first crash
- Window error handler detects chunk load failures and clears cache
- SW supports CLEAR_CACHE message from page
- SW calls `reg.update()` on every page load

## Consequences
- Users with stale cache auto-recover after one crash
- No more white screens from outdated chunks
- Small overhead from cache checks on load
