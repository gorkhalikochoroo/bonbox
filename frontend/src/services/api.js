import axios from "axios";

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

// Auto-retry on timeout or network error (max 2 retries)
api.interceptors.response.use(null, async (err) => {
  const config = err.config;
  if (!config || config._retryCount >= 2) return Promise.reject(err);
  const isRetryable = !err.response || err.code === "ECONNABORTED" || err.response?.status >= 500;
  if (!isRetryable) return Promise.reject(err);
  // Only retry login/register POSTs on network errors (not on 4xx)
  if (config.method === "post" && err.response) return Promise.reject(err);
  config._retryCount = (config._retryCount || 0) + 1;
  await new Promise((r) => setTimeout(r, 1500));
  return api(config);
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
api.interceptors.response.use((res) => {
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
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
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
        reqUrl.endsWith("/auth/refresh");
      // Don't redirect on landing/marketing routes either — those
      // routes work fine without auth, and bouncing visitors to /login
      // is bad UX.
      const isPublicRoute = path === "/" || path === "/landing" || path === "/pricing" || path === "/contact" || path === "/privacy" || path === "/terms";
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
