/**
 * reportClientError — the browser's "phone home when I crash" beacon.
 *
 * The one production failure we cannot catch server-side: a broken or stale
 * frontend deploy (Vercel serving an index that references a chunk hash it no
 * longer builds) dead-ends the user at the ErrorBoundary, and we never hear
 * about it. This fires a minimal, fire-and-forget beacon so the operator sees
 * the breakage in the super-admin error panel instead of waiting for a support
 * ticket.
 *
 * Hard rules (this file is on the crash path — it must be bulletproof):
 *   • ZERO imports. If the module graph is broken, importing api.js (axios,
 *     interceptors, providers) could throw and defeat the whole point. We
 *     resolve the API base and POST by hand.
 *   • FAIL-SOFT. Every path is wrapped; a reporter that throws while the app
 *     is already crashing is worse than no reporter. It never rejects.
 *   • MINIMAL-PII. Six bounded fields — route, message, kind, build, chunk —
 *     and credentials:"omit". No body, no tokens, no financial data. The
 *     server reads the User-Agent from the request header, we never send it.
 *   • RATE-LIMITED at the source. Session dedupe + a hard per-session cap so a
 *     render loop can't hammer the endpoint (the server also caps at 10/min).
 */

// Build stamp injected by vite.config.js `define`. Guarded so a missing define
// (e.g. a raw unit-test import) degrades to "dev" instead of a ReferenceError.
const BUILD_ID = (() => {
  try {
    // eslint-disable-next-line no-undef
    return typeof __BUILD_ID__ !== "undefined" ? String(__BUILD_ID__) : "dev";
  } catch { return "dev"; }
})();

// Same resolution api.js uses, inlined so we take no import (this file's hard
// ZERO-imports rule — importing utils/platform.js would pull @capacitor/core
// onto the crash path). Vite replaces import.meta.env.VITE_API_URL with a
// literal at build time.
function apiBase() {
  // Native shell (Capacitor) always reports to prod — window.location.hostname
  // is "localhost" in the WKWebView, so without this the beacon (the one
  // channel that would reveal a stranded build) would itself point at the dead
  // localhost:8000. Guarded so a missing global never throws on the crash path.
  try {
    if (typeof window !== "undefined" && window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
      return "https://api.bonbox.dk/api";
    }
  } catch { /* ignore — fall through */ }
  try {
    const env = import.meta.env && import.meta.env.VITE_API_URL;
    if (env) return String(env).replace(/\/$/, "");
  } catch { /* ignore */ }
  try {
    const h = (typeof window !== "undefined" && window.location && window.location.hostname) || "";
    if (h === "bonbox.dk" || h.endsWith(".bonbox.dk")) return "https://api.bonbox.dk/api";
  } catch { /* ignore */ }
  return "http://localhost:8000/api";
}

const _sent = new Set();       // session dedupe: one report per unique signature
let _count = 0;                // hard per-session cap (belt-and-suspenders)
const _MAX_PER_SESSION = 8;

/**
 * @param {{kind?: string, message?: string, chunk?: string, route?: string}} opts
 */
export function reportClientError(opts) {
  try {
    if (_count >= _MAX_PER_SESSION) return;

    const kind = (opts && opts.kind) || "other";
    let route = "";
    try { route = (window.location && window.location.pathname) || ""; } catch { /* ignore */ }
    if (opts && opts.route) route = opts.route;

    const message = String((opts && opts.message) || "").slice(0, 500);
    const chunk = String((opts && opts.chunk) || "").slice(0, 160);

    // Dedupe on the shape of the failure, not the exact message (messages vary
    // per attempt). Same kind+route+chunk once per session is enough signal.
    const sig = kind + "|" + route + "|" + chunk;
    if (_sent.has(sig)) return;
    _sent.add(sig);
    _count += 1;

    const payload = JSON.stringify({
      kind: String(kind).slice(0, 40),
      route: route.slice(0, 200),
      message,
      chunk,
      build_id: BUILD_ID.slice(0, 60),
    });

    const url = apiBase() + "/diagnostics/client-error";

    // Primary: fetch(keepalive) — survives the page unload that an
    // ErrorBoundary reload triggers, and lets us set credentials:"omit".
    let ok = false;
    try {
      if (typeof fetch === "function") {
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          keepalive: true,
          credentials: "omit",
          mode: "cors",
        }).catch(() => {});
        ok = true;
      }
    } catch { /* fall through to beacon */ }

    // Fallback: sendBeacon (older/edge cases where fetch keepalive is absent).
    if (!ok) {
      try {
        if (navigator && typeof navigator.sendBeacon === "function") {
          navigator.sendBeacon(url, new Blob([payload], { type: "application/json" }));
        }
      } catch { /* give up silently — reporting is best-effort */ }
    }
  } catch {
    // Absolute last resort: never let the reporter itself throw.
  }
}

export default reportClientError;
