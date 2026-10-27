import axios from "axios";
import { getRevealProof, setRevealProof, triggerDeviceLock } from "./deviceShare";
import { platform } from "../utils/platform";
import { standRewrite } from "./standAuth";
import { requestStarted, requestSettled } from "./apiActivity";
import { cacheGeneration, rememberGet, noteWrite, invalidateCache } from "../lib/swrCache";

// The one prod origin. A native Capacitor shell (iOS/Android) has NO other
// backend it could ever talk to — it ships pre-built and always points here.
// VITE_NATIVE_API_URL lets a LOCAL simulator build talk to a local backend
// (e.g. http://localhost:8000/api) with local test data. Unset in every real
// build, so the store apps always talk to production.
const PROD_API_URL = import.meta.env.VITE_NATIVE_API_URL || "https://api.bonbox.dk/api";

// Default API URL when no VITE_API_URL env var is set. Production users on
// any *.bonbox.dk page get pointed at api.bonbox.dk so cookies stay
// first-party (Round 2 — same registrable domain → SameSite=Lax + JS-
// readable CSRF cookie). Vercel env vars still win if explicitly set.
const _DEFAULT_API_URL = (() => {
  // Native shell first: window.location.hostname is "localhost" inside a
  // Capacitor WKWebView, so the hostname branch below can NEVER fire on-device.
  // Without this, native falls through to the localhost:8000 dead-end. Belt +
  // braces with the baseURL guard below.
  if (platform.isNative) return PROD_API_URL;
  try {
    const h = (typeof window !== "undefined" && window.location?.hostname) || "";
    if (h === "bonbox.dk" || h.endsWith(".bonbox.dk")) {
      return PROD_API_URL;
    }
  } catch { /* SSR / sandboxed — fall through */ }
  return "http://localhost:8000/api";
})();

const api = axios.create({
  // Native → hard-forced to prod, ABOVE the env var, so a mis-baked or empty
  // VITE_API_URL (e.g. a --mode slip letting .env.local=localhost win) can
  // never strand the app on the phone's own localhost. Web → explicit env
  // override wins, else the host-based default.
  baseURL: platform.isNative ? PROD_API_URL : (import.meta.env.VITE_API_URL || _DEFAULT_API_URL),
  timeout: 60000, // 60s timeout for slow connections (Nepal, etc.)
  // Send the HttpOnly auth cookie set by /auth/login. Pairs with the
  // existing Authorization: Bearer header — backend accepts either.
  // Defense layer: even if XSS exfiltrates localStorage, the HttpOnly
  // cookie can't be read by JS. CORS allow_credentials=true is already
  // configured on the backend.
  withCredentials: true,
});

// ── Requests in flight (services/apiActivity) ──────────────────────
// Registered FIRST so it sees every request and every final answer. A
// retried request is counted once, from its first send to its first answer —
// a retry can only make the count read LOW for a moment, which just lets a
// waiting page show a touch early; every waiter has its own time cap too.
api.interceptors.request.use((config) => {
  if (!config._bbCounted) {
    config._bbCounted = true;
    requestStarted();
    // The cache generation this request started in (lib/swrCache): an answer
    // to a request sent before a write is never stored after it.
    config._bbGen = cacheGeneration();
  }
  return config;
});
const settle = (config) => {
  if (config && config._bbCounted && !config._bbSettled) {
    config._bbSettled = true;
    requestSettled();
  }
};
// Home's stale-while-revalidate memory (lib/swrCache): a GET's answer is kept
// for the few read-only paths Home's cards fire; any successful write (bar
// telemetry) throws the whole copy away. Never lets a cache problem touch
// the response itself.
const isWrite = (config) => {
  const m = String((config && config.method) || "get").toLowerCase();
  return m !== "get" && m !== "head" && m !== "options";
};
const noteAnswer = (res) => {
  try {
    const config = res?.config || {};
    const method = String(config.method || "get").toLowerCase();
    if (method === "get") rememberGet(config.url, config.params, res.data, config._bbGen);
    else if (isWrite(config)) noteWrite(config.url);
  } catch {
    /* the cache is a convenience — never a failure */
  }
};
// A write that has answered (either way) ends every join: a read asked for
// after it must be a NEW request, never the answer to one sent before it
// (the in-flight join below, B).
const endJoinsOnWrite = (config) => {
  try { if (isWrite(config)) forgetInflightGets(); } catch { /* never fails the request */ }
};
api.interceptors.response.use(
  (res) => { settle(res?.config); endJoinsOnWrite(res?.config); noteAnswer(res); return res; },
  (err) => { settle(err?.config); endJoinsOnWrite(err?.config); return Promise.reject(err); },
);

/**
 * The account a bearer token signs in as (its `sub`), for telling one
 * session from another; the token itself when it cannot be read. null for
 * no token (a cookie session). R-c round 2 fix-up.
 */
export function tokenSubject(tok) {
  if (!tok) return null;
  try {
    const part = String(tok).split(".")[1];
    const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    return json && json.sub != null ? `sub:${json.sub}` : String(tok);
  } catch {
    return String(tok);
  }
}
const storedToken = () => {
  try { return localStorage.getItem("token"); } catch { return null; }
};
const headerOf = (headers, name) => {
  if (!headers) return null;
  try {
    if (typeof headers.get === "function") return headers.get(name) ?? null;
  } catch { /* plain object below */ }
  return headers[name] ?? null;
};

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
  // Retrying a NON-IDEMPOTENT method is only safe when we know the
  // server did not process the request. There is exactly one such
  // signal: 503, which is defined as "the server has NOT processed
  // this" (the Render cold-start case for /auth/login, /demo/seed…).
  //
  // A bare network error is NOT that signal. `err.response` is also
  // undefined when the request DID reach the server, the handler
  // committed, and the RESPONSE was lost — a dropped socket, a mobile
  // network handoff, or our own 60s timeout firing ECONNABORTED. The
  // old rule read `err.response &&`, which is falsy in exactly that
  // case, so it fell through and REPLAYED the POST up to 4 times at
  // 2s / 6s / 14s / 26s cumulative.
  //
  // That is a duplicate generator, and it is visible in production: the
  // measured collision pairs sit 6 and 23 seconds apart — the first two
  // backoff steps — on the typed expense path, with no receipt photos.
  // Each replay booked another expense and double-claimed its MOMS.
  //
  // GET/HEAD/OPTIONS are idempotent and keep retrying on everything.
  const idempotentMethod = ["get", "head", "options"].includes(
    (config.method || "get").toLowerCase(),
  );
  if (!idempotentMethod && status !== 503) {
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
  // R-c round 2 fix-up — a retry goes on the credential the request was
  // first sent with, or not at all: re-run, the request interceptor attaches
  // whatever token is stored NOW, and a phone signed out and in as another
  // owner during the back-off filed the first owner's queued close in the
  // second owner's books. (A cookie session cannot be told apart here — the
  // server refuses a Daily close write built for another account.)
  if (Object.prototype.hasOwnProperty.call(config, "_bbAuthAtSend")
    && tokenSubject(storedToken()) !== tokenSubject(config._bbAuthAtSend)) {
    return Promise.reject(err);
  }
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
    // R-c round 2 fix-up — only for the session still stored on this phone:
    // a late answer to a request owner A sent before signing out (owner B
    // signed in since) carried A's refreshed token, and writing it over B's
    // signed every later request in as A — B's figures filed in A's books.
    const sentAuth = headerOf(res?.config?.headers, "Authorization");
    const cur = storedToken();
    const sameSession = (sentAuth || null) === (cur ? `Bearer ${cur}` : null);
    if (newToken && typeof newToken === "string" && newToken.length > 20 && sameSession) {
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
  // ── Paired host-stand device ────────────────────────────────────────
  // A device opened at /stand/<token> authenticates by TOKEN IN THE PATH,
  // not a session. Rewrite reservation calls onto the stand prefix so
  // ReservationsPage needs no second data layer, and DROP the session
  // credentials on those calls: a stand must never carry both, or an owner
  // session that happened to exist in this browser would silently hand the
  // device owner-level reach. Scope is enforced server-side — the backend
  // accepts this credential on its wrapped operations only and 404s everything
  // else — so this rewrite cannot widen what the device can do.
  const rewritten = standRewrite(config.url);
  if (rewritten) {
    config.url = rewritten;
    config.withCredentials = false;
    if (config.headers) delete config.headers.Authorization;
    return config;
  }

  const token = localStorage.getItem("token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  // The credential this request FIRST went with (a retry never goes on
  // another one — the retry interceptor above).
  if (!Object.prototype.hasOwnProperty.call(config, "_bbAuthAtSend")) config._bbAuthAtSend = token || null;
  // Tell the backend whether we're inside a Capacitor native shell so it can
  // apply iOS-IAP-compliance rules to billing endpoints. Web requests get "web".
  //
  // ON THE WEB, ONLY ON WRITES (E, speed push 15 Oct). A custom header turns
  // a cross-origin GET from bonbox.dk to api.bonbox.dk into a "non-simple"
  // request, and the browser then sends an OPTIONS preflight first — one
  // extra round trip per read, 33 of them on a cold Home open. Nothing on
  // the server reads either header on a read: the platform header is read by
  // the Stripe checkout POST only (routers/billing.py), and CSRF is checked
  // on POST/PUT/PATCH/DELETE only (main.py csrf_protect returns early for
  // GET/HEAD/OPTIONS). So a web GET goes without them and needs no preflight;
  // every write still carries both. The native shell is unchanged: its
  // bearer token is itself a non-simple header, so it gains nothing here.
  const method = String(config.method || "get").toLowerCase();
  const isRead = method === "get" || method === "head";
  let isNative = false;
  try {
    if (window.Capacitor?.isNativePlatform?.()) {
      isNative = true;
      config.headers["X-BonBox-Platform"] = window.Capacitor.getPlatform?.() || "native";
    } else if (!isRead) {
      config.headers["X-BonBox-Platform"] = "web";
    }
  } catch (_) {
    if (!isRead) config.headers["X-BonBox-Platform"] = "web";
  }
  // CSRF: web sessions echo the bonbox_csrf cookie back as X-CSRF-Token. The
  // backend rejects state-changing cookie-auth requests where the header is
  // missing or doesn't match the cookie. Native shells skip this — they
  // authenticate via Authorization: Bearer, which the backend treats as
  // already CSRF-safe (the bearer token isn't auto-attached cross-origin).
  // Writes only (see above): a read is never CSRF-checked.
  if (!isNative && !isRead) {
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

/**
 * What a 401 does, from the page the browser is on and the request that got
 * it: `redirect` — send the browser to /login; `wipeToken` — drop the stored
 * bearer token. A pure function (exported for tests) so the rules can be
 * read and checked in one place.
 */
export function on401(path, reqUrl = "") {
  const isAuthPage = path === "/login" || path === "/register" || path.startsWith("/forgot") || path.startsWith("/reset") || path.startsWith("/s/");
  // /login/magic and /login/claim answer a link from a mail: a forged or
  // unknown login-link token is a 401 from verify, and the page itself
  // says "Dette link er ugyldigt" + "Få et nyt link" — the redirect to
  // /login said nothing (release gate, 9 Oct). Never redirected; a
  // stale token is still wiped as before.
  // /accept-invite/… (a team or revisor invite from a mail) is the same: a
  // locked invitee's 401 is said on the page ("Denne konto er låst …").
  const isLinkLanding = path.startsWith("/login/") || path.startsWith("/accept-invite/");
  // Don't redirect on auth-probe endpoints — those are silent
  // "are we logged in?" checks (called by AuthProvider on every
  // public page load too). Without this, an expired-token visitor
  // landing on `/` would get bounced to `/login` instead of seeing
  // the marketing landing page. Probes belong to the calling code,
  // not the global redirect.
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
  // R10 — a paired door screen (/stand, /stand/<token>) has no session and
  // must never be sent to the owner login: 13 of 13 cold starts of a door
  // iPad ended on "Velkommen tilbage" because one early request went out as
  // the owner's. Its own failures are said on the stand itself ("Offline",
  // "Denne skærm er ikke forbundet"). Nor is an owner token that happens to
  // live in this browser wiped from here — the stand never sends it.
  // (/reservations/stand is the OWNER's pop-out, a real session: unchanged.)
  const isStandDevice = path === "/stand" || path.startsWith("/stand/");
  return {
    redirect: !isAuthPage && !isLinkLanding && !isAuthProbe && !isPublicRoute && !isStandDevice,
    wipeToken: !isAuthPage && !isStandDevice,
  };
}

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
      // Whoever this session was, Home's copy of their figures is not to be
      // drawn again (lib/swrCache).
      try { invalidateCache(); } catch { /* never fails the request */ }
      const { redirect, wipeToken } = on401(window.location.pathname, err.config?.url || "");
      if (redirect) {
        localStorage.removeItem("token");
        window.location.href = "/login";
      } else if (wipeToken) {
        // Still wipe the stale token so subsequent calls don't keep
        // sending it. Calling code's .catch handler decides what to do.
        try { localStorage.removeItem("token"); } catch {}
      }
    }
    return Promise.reject(err);
  }
);

// ── One request for identical reads in flight (B, speed push 15 Oct) ──
// Home's cards ask some of the same questions at the same moment: /business
// (tonight's-close check + the connections card), /email/preferences (the
// brief + the connections card), /branches/list twice in the iOS app. While
// an identical GET is still on its way, a second caller joins it instead of
// sending another. Identical means: same path, same params, same signed-in
// credential, plain JSON (no custom headers, no abort signal, no blob).
// Each joiner gets its OWN copy of the answer, so a caller that sorts or
// edits what it got cannot change what another caller sees. Once the answer
// is in, the next call asks the server again — this is not a cache.
const _inflightGets = new Map();
const _sendGet = api.get.bind(api);
// Hoisted declaration: the response interceptor above calls this.
function forgetInflightGets() {
  _inflightGets.clear();
}

function _deepCopy(data) {
  try {
    return typeof structuredClone === "function"
      ? structuredClone(data)
      : JSON.parse(JSON.stringify(data));
  } catch {
    return data;
  }
}

function _getKey(url, config) {
  if (config && (config.headers || config.signal || config.cancelToken || config.adapter)) return null;
  if (config && config.responseType && config.responseType !== "json") return null;
  const params = config && config.params;
  let p = "";
  if (params != null) {
    // Plain objects only (a URLSearchParams or a class instance is never
    // joined); values compared as JSON, so ["1,2"] and [1, 2] never collide.
    if (Object.prototype.toString.call(params) !== "[object Object]") return null;
    p = Object.keys(params).sort().map((k) => `${k}=${JSON.stringify(params[k])}`).join("&");
  }
  return `${String(url)}?${p}|${tokenSubject(storedToken()) || "cookie"}|${config && config._noRetry ? 1 : 0}`;
}

api.get = (url, config) => {
  const key = _getKey(url, config);
  if (!key) return _sendGet(url, config);
  const running = _inflightGets.get(key);
  if (running) {
    running.joiners += 1;
    // Each joiner gets a copy of the answer as it ARRIVED (snapshot below),
    // never the object the first caller may already have changed.
    return running.promise.then((res) => ({ ...res, data: _deepCopy(running.snapshot) }));
  }
  const entry = { promise: null, joiners: 0, snapshot: undefined };
  const p = _sendGet(url, config);
  entry.promise = p;
  _inflightGets.set(key, entry);
  // Registered before the first caller's own handler, so it runs first: the
  // pristine answer is kept for the joiners (copied only if there are any).
  const done = () => { if (_inflightGets.get(key) === entry) _inflightGets.delete(key); };
  p.then((res) => {
    if (entry.joiners > 0) entry.snapshot = _deepCopy(res && res.data);
    done();
  }, done);
  return p;
};

export default api;
