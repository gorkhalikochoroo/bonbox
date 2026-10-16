/**
 * swrCache — Home's last answers, kept IN MEMORY for the signed-in owner, so
 * going back to the dashboard draws it at once and refreshes it quietly
 * (stale-while-revalidate) instead of a wall of skeletons on every visit
 * (owner screenshot, 15 Oct: skeletons on every back-and-forth).
 *
 * What it holds
 *   • the last /dashboard/batch answer (Home's money, the trend, the stock …)
 *   • the last answer of the few read-only GETs Home's own cards fire
 *     (GET_ALLOW below) — so a re-mounted card draws its last state too.
 *
 * Who may use it — never shows one account's data to another
 *   • One account at a time. AuthProvider names the account on every change
 *     of signed-in user (setCacheAccount); a different account — or none,
 *     after logout or a 401 — empties everything first.
 *   • Owners only. An invited seat (manager / cashier / viewer) and a revisor
 *     login get no cache: their answers are redacted per seat, and a revisor
 *     moves between clients.
 *   • Never on a shared ("Delt enhed") device: there the server withholds the
 *     money while the curtain is up, and a copy taken while it was lifted
 *     must not be drawn under a lowered one. DeviceShareProvider reports the
 *     device (setSharedDevice); until it has, nothing is stored or read.
 *   • Memory only. Nothing is written to localStorage / sessionStorage — a
 *     reload, a new tab or a cold app start begins empty.
 *
 * When it is thrown away
 *   • Any successful write through the API client (POST/PUT/PATCH/DELETE —
 *     services/api.js), except the telemetry pings in WRITE_IGNORE, and every
 *     `bonbox-data-changed` event (the app's freshness bus). After the owner
 *     changes anything, Home waits for the server again rather than drawing
 *     figures from before the change.
 *   • An answer older than MAX_AGE_MS, or from another business day, is not
 *     drawn (a phone woken in the morning must not show last night's "I dag").
 *   • A response that was requested BEFORE a throw-away is not stored after it
 *     (generation check), so a late answer cannot re-plant pre-write figures.
 */

export const MAX_AGE_MS = 30 * 60 * 1000;
/** Home says "Opdateret for N min. siden" while it draws data at least this old. */
export const STALE_NOTE_AFTER_MS = 3 * 60 * 1000;

// Read-only GETs Home's cards fire. Paths as the API client sees them
// (relative to /api), without the query string.
export const GET_ALLOW = new Set([
  "/diagnostics/needs-you",
  "/smart-drift",
  "/demo/status",
  "/dashboard/anomalies",
  "/branches/summary",
  "/business",
  "/accountants/grants",
  "/email/preferences",
  "/cashflow/forecast",
  "/dashboard/daily-brief",
  "/accountant-savings/current-month",
  "/staff/today",
  "/output-channels",
]);

// Writes that change no figure Home shows: analytics and crash beacons.
const WRITE_IGNORE = [/^\/event-log(\/|$)/, /^\/diagnostics\/client-error/];

const STAFF_ROLES = new Set(["manager", "cashier", "viewer"]);

let _account = null; // "userId|role" or null
let _shared = true; // unknown until DeviceShareProvider reports → no cache
let _gen = 0; // bumped by every throw-away
let _dashboard = null; // { account, businessDay, at, data }
const _gets = new Map(); // key → { account, at, data }

function _clear() {
  _dashboard = null;
  _gets.clear();
  _gen += 1;
}

/** The cache key for a signed-in user, or null when this user gets no cache. */
export function accountKeyFor(user) {
  if (!user || user.id == null) return null;
  const role = String(user.role || "owner").toLowerCase();
  if (STAFF_ROLES.has(role) || role === "accountant") return null;
  return `${user.id}|${role}`;
}

/** AuthProvider: the account now signed in (null = signed out / no cache). */
export function setCacheAccount(key) {
  const next = key || null;
  if (next !== _account) _clear();
  _account = next;
}

/** DeviceShareProvider: true while this device is (or may be) shared. */
export function setSharedDevice(shared) {
  const next = shared !== false;
  if (next && !_shared) _clear();
  _shared = next;
}

function _usable() {
  return !!_account && !_shared;
}

/** Throw everything away (a write, the freshness bus, a 401). */
export function invalidateCache() {
  _clear();
}

/** The generation a request starts in; pass it back when storing its answer. */
export function cacheGeneration() {
  return _gen;
}

// ── /dashboard/batch ────────────────────────────────────────────────────

export function readDashboard(businessDay, now = Date.now()) {
  if (!_usable() || !_dashboard) return null;
  if (_dashboard.account !== _account) return null;
  if (_dashboard.businessDay !== businessDay) return null;
  if (now - _dashboard.at > MAX_AGE_MS) return null;
  return { data: _dashboard.data, at: _dashboard.at, ageMs: now - _dashboard.at };
}

export function writeDashboard(businessDay, data, gen, now = Date.now()) {
  if (!_usable() || gen !== _gen || !data || typeof data !== "object") return false;
  _dashboard = { account: _account, businessDay, at: now, data };
  return true;
}

// ── the cards' GETs ─────────────────────────────────────────────────────

function _path(url) {
  return String(url || "").split("?")[0];
}

function _key(url, params) {
  const p = params && typeof params === "object"
    ? Object.keys(params).sort().map((k) => `${k}=${String(params[k])}`).join("&")
    : "";
  return `${_path(url)}?${p}`;
}

/** The last answer this account got for GET url+params, or undefined. */
export function peekGet(url, params, now = Date.now()) {
  if (!_usable() || !GET_ALLOW.has(_path(url))) return undefined;
  const e = _gets.get(_key(url, params));
  if (!e || e.account !== _account || now - e.at > MAX_AGE_MS) return undefined;
  return e.data;
}

/** services/api.js: a GET answered. Stored only for allow-listed paths. */
export function rememberGet(url, params, data, gen, now = Date.now()) {
  if (!_usable() || gen !== _gen || !GET_ALLOW.has(_path(url))) return;
  _gets.set(_key(url, params), { account: _account, at: now, data });
}

/** services/api.js: a write answered. Anything but telemetry throws the cache away. */
export function noteWrite(url) {
  const p = _path(url);
  if (WRITE_IGNORE.some((re) => re.test(p))) return;
  _clear();
}

// The app's freshness bus: whoever changed data says so, and Home's copy is
// no longer the truth.
try {
  if (typeof window !== "undefined") {
    window.addEventListener("bonbox-data-changed", () => _clear());
  }
} catch {
  /* no DOM */
}

/** Tests only. */
export function __resetSwrCacheForTests() {
  _account = null;
  _shared = true;
  _clear();
}
