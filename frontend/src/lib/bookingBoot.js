// What index.html already started for the booking page (booking R5).
//
// The parse-time script (scripts/bookingBoot.mjs) asks for the page's data
// while the app's code is still downloading — on slow 4G that wait used to
// come AFTER the code, one more serial round trip before the venue's name and
// its times could show. It leaves the requests on window.__bbBooking:
//   page     GET /public/reservations/<slug>
//   avail    GET …/availability?day=&party=          (its guess: .day, .party)
//   summary  GET …/availability-summary?from=&days=14&party=
// each { base, url, promise → {ok, status, data}, done }.
//
// The page takes one over only when it is exactly the request it would send
// now — same API, same venue, same day and party — and only once. Otherwise
// (or when it failed in a way a retry could fix: no network, a 5xx, a 429,
// the 15 s give-up) the page asks itself, through the api client and its
// retries, as before. A 4xx answer is the answer (a 410 "not taking
// bookings" is that venue's truth either way).
import api from "../services/api";

const taken = new Set();

function boot() {
  try {
    return (typeof window !== "undefined" && window.__bbBooking) || null;
  } catch {
    return null;
  }
}

const apiBase = () => String(api.defaults?.baseURL || "").replace(/\/+$/, "");

function probeFor(kind, want) {
  if (taken.has(kind)) return null;
  const b = boot();
  if (!b || b.slug !== want.slug) return null;
  const pr = b[kind];
  if (!pr || !pr.promise || typeof pr.promise.then !== "function") return null;
  if (!apiBase() || pr.base !== apiBase()) return null;
  if (kind === "avail" && (pr.day !== want.day || Number(pr.party) !== Number(want.party))) return null;
  if (kind === "summary" && (pr.from !== want.from || Number(pr.days) !== Number(want.days) || Number(pr.party) !== Number(want.party))) return null;
  return pr;
}

/**
 * The page data, if it has ALREADY landed (a synchronous peek — the page uses
 * it for its first render, so a fast probe means no skeleton at all). Takes
 * nothing: markBootPageUsed() does that once the page has committed.
 */
export function peekBootPage(slug) {
  const pr = probeFor("page", { slug });
  return pr && pr.done && pr.done.ok && pr.done.data && typeof pr.done.data === "object" ? pr.done.data : null;
}

export function markBootPageUsed() {
  taken.add("page");
}

function asAxiosError(r) {
  const e = new Error(`Request failed with status code ${r.status}`);
  e.response = { status: r.status, data: r.data };
  return e;
}

/**
 * The answer index.html already asked for, else `fallback()` (the page's own
 * api call). Resolves like axios: { data }; rejects like axios on a 4xx.
 *   kind  "page" | "avail" | "summary"
 *   want  { slug } (+ day, party | from, days, party)
 */
export function bootOr(kind, want, fallback) {
  const pr = probeFor(kind, want);
  if (!pr) return fallback();
  taken.add(kind);
  return pr.promise.then((r) => {
    if (r && r.ok) return { data: r.data };
    if (r && r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) throw asAxiosError(r);
    return fallback();
  }, fallback);
}

/** Tests only: forget what was taken. */
export function resetBootForTests() {
  taken.clear();
}
