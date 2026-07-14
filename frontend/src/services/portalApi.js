/**
 * Portal API client — separate from the main api.js.
 * Does NOT attach Bearer tokens or redirect to /login on 401.
 * Used exclusively by the staff self-service portal (/s/:token).
 */
import axios from "axios";
import { platform } from "../utils/platform";

// This is the scheduler iOS app's PRIMARY client — every /s/:token portal +
// /join screen goes through here. The native shell has exactly one backend.
const PROD_API_URL = "https://api.bonbox.dk/api";

// Same defaulting logic as api.js — bonbox.dk pages point at api.bonbox.dk.
const _DEFAULT_API_URL = (() => {
  // Native shell always talks to prod: hostname is "localhost" in a Capacitor
  // WKWebView, so the hostname check never fires and the app would otherwise
  // fall through to the localhost:8000 dead-end. This is the layer that makes
  // the scheduler connection independent of the build-time env var.
  if (platform.isNative) return PROD_API_URL;
  try {
    const h = (typeof window !== "undefined" && window.location?.hostname) || "";
    if (h === "bonbox.dk" || h.endsWith(".bonbox.dk")) {
      return PROD_API_URL;
    }
  } catch { /* SSR / sandboxed */ }
  return "http://localhost:8000/api";
})();

const portalApi = axios.create({
  // Native → forced prod regardless of env (never localhost on a phone).
  // Web → env override wins, else host default.
  baseURL: platform.isNative ? PROD_API_URL : (import.meta.env.VITE_API_URL || _DEFAULT_API_URL),
  timeout: 30000,
});

// Proof-of-PIN (multi-layer link protection). /verify-pin mints a signed
// proof; we persist it per portal token and attach it as X-BonBox-Pin on
// every request for THAT token. The backend enforces it on all data
// endpoints of a PIN-protected link — the PIN is a real server-side gate,
// not UI decoration. Links without a PIN never see this header enforced.
const PIN_PROOF_KEY = "bonbox_pin_proof";

export function storePinProof(token, proof) {
  try {
    localStorage.setItem(PIN_PROOF_KEY, JSON.stringify({ token, proof }));
  } catch { /* private mode — proof lives for the session via memory below */ }
  _memProof = { token, proof };
}

let _memProof = null;

function proofFor(url) {
  let stored = _memProof;
  if (!stored) {
    try {
      stored = JSON.parse(localStorage.getItem(PIN_PROOF_KEY) || "null");
    } catch { stored = null; }
  }
  if (!stored?.token || !stored?.proof) return null;
  return url.includes(`/portal/${stored.token}`) ? stored.proof : null;
}

portalApi.interceptors.request.use((config) => {
  const proof = proofFor(config.url || "");
  if (proof) config.headers["X-BonBox-Pin"] = proof;
  return config;
});

// Auto-retry retryable failures (no response / timeout / 5xx).
//
// A sleeping Render dyno takes 20-60s to wake, and its db-readiness gate
// returns FAST 503s during DB init — so a fixed 2×1.5s budget can be exhausted
// before the backend is ready, surfacing as a bare Connect failure (the exact
// "Network Error" the App-Review reviewer could hit on a cold start). A GET or
// the /join lookup is safe to repeat, so give those an exponential budget
// (~1.5+3+6+10s ≈ 20s of backoff, on top of each attempt's own 30s timeout)
// that spans the wake window. Other POSTs (clock-in, chat) keep the short 2-try
// budget so a lost-response replay can't double-submit.
portalApi.interceptors.response.use(null, async (err) => {
  const config = err.config;
  if (!config) return Promise.reject(err);
  const isRetryable = !err.response || err.code === "ECONNABORTED" || err.response?.status >= 500;
  if (!isRetryable) return Promise.reject(err);
  const method = (config.method || "get").toLowerCase();
  const safeToRepeat = method === "get" || (config.url || "").includes("/portal/join");
  const maxRetries = safeToRepeat ? 4 : 2;
  const count = config._retryCount || 0;
  if (count >= maxRetries) return Promise.reject(err);
  config._retryCount = count + 1;
  const delay = safeToRepeat ? Math.min(1500 * 2 ** count, 10000) : 1500;
  await new Promise((r) => setTimeout(r, delay));
  return portalApi(config);
});

export default portalApi;
