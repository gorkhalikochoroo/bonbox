/**
 * Vitest setup — runs once per worker before any test file.
 *
 * Two responsibilities:
 *   1. Register @testing-library/jest-dom matchers so tests can write
 *      `expect(el).toBeInTheDocument()` etc. instead of raw vitest
 *      assertions. Improves readability for component tests.
 *   2. Auto-cleanup the rendered React tree after each test so a
 *      leaked component from one test can't leak into the next.
 *      Without this, tests that assert "only one X exists" become
 *      flaky as the suite grows.
 *
 * Anything else that should be GLOBAL across every test file (mock
 * window.fetch, polyfills, etc.) belongs here. Things that are only
 * relevant to one test file should stay local to that file's
 * beforeEach/afterEach.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// localStorage / sessionStorage stubs — vitest's jsdom env in some
// configurations exposes the namespace but doesn't wire the real
// Storage methods, so a `localStorage.getItem(...)` call fails with
// "is not a function". Components like LanguageProvider call this at
// import time (`useState(() => localStorage.getItem("lang"))`), so we
// must register a working stub BEFORE any component module runs.
//
// We use a real Map-backed implementation rather than a Vitest fn
// mock so test code can read what it wrote without rebuilding the
// mock per test.
function _makeStorageStub() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(String(k), String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => { store.clear(); },
    key: (i) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  };
}

const _ls = _makeStorageStub();
const _ss = _makeStorageStub();
globalThis.localStorage = _ls;
globalThis.sessionStorage = _ss;
if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", { value: _ls, configurable: true });
  Object.defineProperty(window, "sessionStorage", { value: _ss, configurable: true });
}

afterEach(() => {
  // Tear down the rendered tree between tests. RTL does this
  // automatically when its global cleanup is enabled, but we register
  // the hook explicitly so test isolation is visible in the setup file
  // rather than implicit in the library.
  cleanup();
  // Wipe browser storage so a localStorage write in one test can't
  // leak into the next (e.g. setting bonbox_lang to "da" would change
  // every subsequent useLanguage default).
  try { localStorage.clear(); } catch {}
  try { sessionStorage.clear(); } catch {}
});
