// The door screen's product analytics (R11, rubric B11) — what
// hooks/useEventLog.js is, in the door screen's own build only
// (scripts/standBuild.mjs swaps it in).
//
// The app logs an event only with the cookie banner's analytics consent. A
// door screen shows no banner, so it never has that consent and never logs —
// the same answer the app would give, without bundling the banner to ask it.
export function analyticsAllowed() {
  return false;
}

export function analyticsDeclined() {
  return false;
}

export function trackEvent() {}

export function usePageTracking() {}
