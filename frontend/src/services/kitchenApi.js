/**
 * The paired kitchen iPad's own API client (/kitchen/<token>).
 *
 * The credential is the TOKEN IN THE PATH and nothing else: a separate axios
 * instance with no Authorization header, no cookie (withCredentials false),
 * no CSRF, and no 401 → /login redirect. An owner session that happens to live
 * in this browser can therefore never ride along and widen what the device
 * can do; the backend scopes the token to the kitchen wrappers and 404s the
 * rest (routers/kitchen_link.py).
 *
 * GETs retry twice (1.5 s, 3 s) on a network error or a 5xx. A POST of a
 * reading is NEVER replayed inside axios: the screen's own retry resends the
 * same body with the same client_id, which the server answers with the row it
 * already stored (200, replayed) — so a retry can never make a second row.
 *
 * Nothing here logs a value, a name or a token.
 */
import axios from "axios";
import api from "./api";

const REMEMBER_KEY = "bonbox_kitchen_device";
const VENUE_KEY = "bonbox_kitchen_venue";
export const KITCHEN_TOKEN_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** The token in a /kitchen/<token> path, or null (incl. /kitchen itself). */
export function kitchenTokenFromPath(pathname) {
  const m = /^\/kitchen\/([^/?#]+)\/?$/.exec(typeof pathname === "string" ? pathname : "");
  return m && KITCHEN_TOKEN_RE.test(m[1]) ? m[1] : null;
}

/** The pairing this iPad remembers (set after the first good /today), or null. */
export function rememberedKitchenToken() {
  try {
    const v = localStorage.getItem(REMEMBER_KEY);
    return v && KITCHEN_TOKEN_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function rememberKitchenToken(token, venueName = null) {
  try {
    if (!token || !KITCHEN_TOKEN_RE.test(token)) return;
    if (localStorage.getItem(REMEMBER_KEY) !== token) localStorage.setItem(REMEMBER_KEY, token);
    if (venueName) localStorage.setItem(VENUE_KEY, String(venueName).slice(0, 120));
  } catch {
    /* private mode — the address still carries the link */
  }
}

/** The venue the remembered pairing belonged to (for the revoked screen). */
export function rememberedKitchenVenue() {
  try {
    return localStorage.getItem(VENUE_KEY) || null;
  } catch {
    return null;
  }
}

export function forgetKitchenToken() {
  try {
    localStorage.removeItem(REMEMBER_KEY);
    localStorage.removeItem(VENUE_KEY);
  } catch {
    /* private mode */
  }
}

const client = axios.create({
  baseURL: api.defaults.baseURL,
  timeout: 15000,
  withCredentials: false,
});

client.interceptors.request.use((config) => {
  config.withCredentials = false;
  if (config.headers) {
    if (typeof config.headers.delete === "function") config.headers.delete("Authorization");
    else delete config.headers.Authorization;
  }
  return config;
});

const GET_BACKOFF = [1500, 3000];
client.interceptors.response.use(null, async (err) => {
  const config = err?.config;
  if (!config) return Promise.reject(err);
  const method = String(config.method || "get").toLowerCase();
  const status = err.response?.status;
  const transient = !err.response || err.code === "ECONNABORTED" || status >= 500;
  const attempt = config._ekRetry || 0;
  if (method !== "get" || !transient || attempt >= GET_BACKOFF.length) return Promise.reject(err);
  config._ekRetry = attempt + 1;
  await new Promise((r) => setTimeout(r, GET_BACKOFF[attempt]));
  return client(config);
});

const base = (token) => `/kitchen/${encodeURIComponent(token)}`;

export const kitchenApi = {
  today: (token) => client.get(`${base(token)}/today`).then((r) => r.data),
  staff: (token) => client.get(`${base(token)}/staff`).then((r) => r.data),
  saveEntry: (token, body) => client.post(`${base(token)}/entries`, body).then((r) => r.data),
  undo: (token, entryId) =>
    client.post(`${base(token)}/entries/${encodeURIComponent(entryId)}/undo`, {}).then((r) => r.data),
  folder: (token, days = 30) => client.get(`${base(token)}/folder`, { params: { days } }).then((r) => r.data),
  unpair: (token) => client.post(`${base(token)}/unpair`, {}).then((r) => r.data),
};

export default kitchenApi;
