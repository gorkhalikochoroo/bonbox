import axios from "axios";
import { getRevealProof, setRevealProof, triggerDeviceLock } from "./deviceShare";

// Default API URL when no VITE_API_URL env var is set. Production users on
// any *.bonbox.dk page get pointed at api.bonbox.dk so cookies stay
// first-party (Round 2 — same registrable domain → SameSite=Lax + JS-
// readable CSRF cookie). Vercel env vars still win if explicitly set.
const _DEFAULT_API_URL = (() => {
  try {
    const h = (typeof window !== "undefined" && window.location?.hostname) || "";
    if (h === "bonbox.dk" || h.endsWith(".bonbox.dk")) {
      return "https://api.bonbox.dk/api";
    }
  } catch { /* SSR / sandboxed — fall through */ }
  return "http://localhost:8000/api";
})();

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || _DEFAULT_API_URL,
  timeout: 60000, // 60s timeout for slow connections (Nepal, etc.)
  // Send the HttpOnly auth cookie set by /auth/login. Pairs with the
  // existing Authorization: Bearer header — backend accepts either.
  // Defense layer: even if XSS exfiltrates localStorage, the HttpOnly
  // cookie can't be read by JS. CORS allow_credentials=true is already
  // configured on the backend.
  withCredentials: true,
});

// Auto-retry on timeout, network error, or transient 5xx.
//
// Hardened May 2026 after seeing real 503 storms during Render cold-
// starts and queue backpressure. Old config: 2 retries × 1.5s flat =
// 3s window. Render recovery often takes 15-30s, so half the calls
// were still failing visibly to users.
//
// New: 4 retries with exponential backoff (2s, 4s, 8s, 12s; ~26s
// total), which covers the typical Render warmup. 4xx still propagate
// immediately — those are real validation errors, not transient.
api.interceptors.response.use(null, async (err) => {
  const config = err.config;
  if (!config || config._retryCount >= 4) return Promise.reject(err);
  // Opt-out flag: callers that don't want the retry-on-5xx behaviour
  // (e.g. CVR lookup — 503 means upstream quota is gone, retrying for
  // 26 seconds is just stuck-UI theater) pass `_noRetry: true`.
  if (config._noRetry) return Promise.reject(err);
  const status = err.response?.status;
  const isRetryable = !err.response || err.code === "ECONNABORTED" || status >= 500;
  if (!isRetryable) return Promise.reject(err);
  // POSTs:
  //   • Network error (no response) → retry, because the request
  //     never reached the server so re-sending is safe.
  //   • 503 Service Unavailable → retry, because that's the standard
  //     "server temporarily unavailable, please try again" status.
  //     This is the Render cold-start case for /auth/login,
  //     /auth/magic-link/request, /auth/oauth/*, /demo/seed etc.
  //     503 is documented as "the server has NOT processed the
  //     request" so re-sending creates no duplicate side effects.
  //   • 500/502/504 → don't retry, because those could mean the
  //     handler ran half-way and left state behind.
  if (config.method === "post" && err.response && status !== 503) {
    return Promise.reject(err);
  }
  const attempt = config._retryCount || 0;
  const backoffMs = [2000, 4000, 8000, 12000][attempt] || 12000;
  config._retryCount = attempt + 1;
  // Layer 3 — observable retry progress.  The LoginPage (and any
  // future "we're working on it" UI) listens to these events to swap
  // "Cannot reach server" for "Server is waking up — attempt 2 of 4
  // (retrying in 4s)".  Detail carries enough context that the
  // listener can render a meaningful progress strip without owning
  // its own retry counter.
  try {
    window.dispatchEvent(
      new CustomEvent("bonbox:api-retry", {
        detail: {
          url: config.url,
          method: (config.method || "get").toUpperCase(),
          attempt: config._retryCount,
          maxAttempts: 4,
          delayMs: backoffMs,
          status: status || 0,
          isColdStart: status === 503 || !err.response,
        },
      }),
    );
  } catch {
    /* no DOM, no listeners — fine */
  }
  await new Promise((r) => setTimeout(r, backoffMs));
  return api(config);
});

// Layer 3b — when an API call exhausts all retries, fire a
// "give-up" event so UI surfaces can offer fallbacks
// (e.g. LoginPage proposes magic-link instead of password retry).
api.interceptors.response.use(null, async (err) => {
  const config = err.config;
  // Only fire when we've actually retried — i.e. retry path ran and
  // gave up.  A 4xx that propagated immediately is NOT a "give up".
  if (config && (config._retryCount || 0) >= 4) {
    try {
      window.dispatchEvent(
        new CustomEvent("bonbox:api-retry-exhausted", {
          detail: {
            url: config.url,
            method: (config.method || "get").toUpperCase(),
            status: err.response?.status || 0,
          },
        }),
      );
    } catch {
      /* no DOM */
    }
  }
  return Promise.reject(err);
});

// Multi-layer defense: detect _error flag in 200-OK responses.
//
// Backend wraps risky endpoints to ALWAYS return a stable shape — even on
// failure — with `_error: true|"message"` and `_recoverable: true`. This means
// the page renders cleanly and we surface a non-blocking toast/banner instead
// of crashing or showing a blank screen.
//
// Pages that need to react to graceful failures can read `res.data._error`
// directly. The interceptor below dispatches a custom event so a global
// banner component can show the message without every page re-implementing it.
//
// Also piggybacks on every response to pick up X-New-Token from the
// sliding-refresh backend middleware (30d session, midway re-mint).
// When the bearer token is past its midway point (15 days old), the
// backend mints a fresh one and ships it back via `X-New-Token`. Web
// (cookie) sessions don't need this — the backend reissues the
// bonbox_session cookie directly. Native Capacitor / iOS reads the
// header and updates localStorage so the next request uses the fresh
// token. Without this, native sessions would still expire at the
// hard 30d boundary like the old 24h cap.
api.interceptors.response.use((res) => {
  try {
    // Sliding-refresh: backend sets X-New-Token when our bearer is past
    // midway. Save it to localStorage so subsequent requests use it.
    // CORS expose_headers on the backend includes this so axios can
    // actually read it cross-origin. We sanity-check the shape before
    // writing — a malformed value should never wipe a working session.
    const newToken = res?.headers?.["x-new-token"];
    if (newToken && typeof newToken === "string" && newToken.length > 20) {
      try {
        localStorage.setItem("token", newToken);
      } catch {
        /* private mode / storage blocked — bearer falls back to whatever
           the next request can grab from the existing cookie session */
      }
    }
  } catch {
    // Never let the refresh-pickup break a successful response.
  }
  try {
    const data = res?.data;
    if (data && typeof data === "object" && data._error) {
      const msg = typeof data._error === "string"
        ? data._error
        : (data.detail || "Something went wrong loading this section.");
      window.dispatchEvent(
        new CustomEvent("bonbox:soft-error", {
          detail: {
            message: msg,
            recoverable: !!data._recoverable,
            url: res?.config?.url || "",
          },
        }),
      );
    }
  } catch (_) {
    // Never let the interceptor itself break a successful response
  }
  return res;
});

// Read a cookie from document.cookie. Returns the decoded value, or empty
// string if the cookie isn't set. We only call this for the CSRF token,
// which is intentionally non-HttpOnly so JS can echo it back as a header.
function _readCookie(name) {
  try {
    const prefix = encodeURIComponent(name) + "=";
    for (const part of document.cookie.split("; ")) {
      if (part.startsWith(prefix)) return decodeURIComponent(part.slice(prefix.length));
    }
  } catch { /* document.cookie blocked — fail open, request will 403 if needed */ }
  return "";
}

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  // Tell the backend whether we're inside a Capacitor native shell so it can
  // apply iOS-IAP-compliance rules to billing endpoints. Web requests get "web".
  let isNative = false;
  try {
    if (window.Capacitor?.isNativePlatform?.()) {
      isNative = true;
      config.headers["X-BonBox-Platform"] = window.Capacitor.getPlatform?.() || "native";
    } else {
      config.headers["X-BonBox-Platform"] = "web";
    }
  } catch (_) {
    config.headers["X-BonBox-Platform"] = "web";
  }
  // CSRF: web sessions echo the bonbox_csrf cookie back as X-CSRF-Token. The
  // backend rejects state-changing cookie-auth requests where the header is
  // missing or doesn't match the cookie. Native shells skip this — they
  // authenticate via Authorization: Bearer, which the backend treats as
  // already CSRF-safe (the bearer token isn't auto-attached cross-origin).
  if (!isNative) {
    const csrf = _readCookie("bonbox_csrf");
    if (csrf) config.headers["X-CSRF-Token"] = csrf;
  }
  // Shared-device ("Delt enhed") reveal proof — echoed so the backend pin_gate
  // lifts the curtain on the owner's financial reads for the reveal window (#379).
  // In-memory only; absent (and thus harmless) for any non-shared device.
  const _revealProof = getRevealProof();
  if (_revealProof) config.headers["X-BonBox-Device-Pin"] = _revealProof;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    // Shared-device ("Delt enhed"): the backend curtained a financial read on
    // this shared device — drop the stale proof + raise the LockScreen (#379).
    if (
      err.response?.status === 403 &&
      err.response?.data?.detail?.code === "device_pin_required"
    ) {
      try { setRevealProof(null); triggerDeviceLock(); } catch { /* no-op */ }
    }
    if (err.response?.status === 401) {
      const path = window.location.pathname;
      const isAuthPage = path === "/login" || path === "/register" || path.startsWith("/forgot") || path.startsWith("/reset") || path.startsWith("/s/");
      // Don't redirect on auth-probe endpoints — those are silent
      // "are we logged in?" checks (called by AuthProvider on every
      // public page load too). Without this, an expired-token visitor
      // landing on `/` would get bounced to `/login` instead of seeing
      // the marketing landing page. Probes belong to the calling code,
      // not the global redirect.
      const reqUrl = err.config?.url || "";
      const isAuthProbe =
        reqUrl.includes("/auth/me") ||
        reqUrl.includes("/billing/me") ||
        // Entitlements is a silent "what plan are you on?" probe fired by
        // EntitlementsProvider on EVERY page load (incl. logged-out public
        // pages). A 401 here just means "not signed in" — it must never
        // bounce a visitor to /login, exactly like /auth/me + /billing/me.
        reqUrl.includes("/billing/entitlements") ||
        reqUrl.endsWith("/auth/refresh");
      // Don't redirect on landing/marketing OR public deep-link routes —
      // those work fine without auth, and bouncing visitors to /login is
      // bad UX. The /r/ (reservation booking), /e/ (event) and /t/ (ticket)
      // pages are customer-facing: a guest scanning a QR is logged out by
      // definition, so a 401 from any incidental authed call (entitlements,
      // features, …) must NOT hijack their booking flow into /login.
      const isPublicRoute =
        path === "/" || path === "/landing" || path === "/pricing" ||
        path === "/contact" || path === "/privacy" || path === "/terms" ||
        path === "/cookies" ||
        path.startsWith("/r/") || path.startsWith("/e/") || path.startsWith("/t/");
      if (!isAuthPage && !isAuthProbe && !isPublicRoute) {
        localStorage.removeItem("token");
        window.location.href = "/login";
      } else {
        // Still wipe the stale token so subsequent calls don't keep
        // sending it. Calling code's .catch handler decides what to do.
        if (!isAuthPage) {
          try { localStorage.removeItem("token"); } catch {}
        }
      }
    }
    return Promise.reject(err);
  }
);

export default api;
