// Which addresses are a restaurant's public booking page (booking R5).
//
// The page lives at /r/<slug> (the embed, and old links) and at the root
// vanity /<slug> (the link an owner shares). The vanity form cannot be told
// from an app page by its shape, so it is decided the way the router and the
// backend decide it: a single path segment that no app route owns. Every
// top-level app route is in RESERVED_SLUGS — the backend refuses those as a
// venue's link (routers/reservations.py RESERVED_SLUGS, guarded against
// App.jsx by tests/test_public_slug_danish_letters.py) — so a single segment
// outside the list is the booking page (or its "not found" state).
//
// RESERVED_SLUGS is a COPY of the backend list; r5.bookingPath.test.js fails
// the moment the two differ, or an App.jsx route is missing here.
//
// Read by: the language provider (the page brings its own words — no full
// dictionary), the session/flags providers and the keep-alive (a guest's
// page makes no owner-app call), App.jsx's dictionary gate and the guest
// wait, and — generated into index.html — the parse-time boot script
// (scripts/bookingBoot.mjs).
export const RESERVED_SLUGS = [
  "about", "accept-invite", "accountant", "admin", "api", "app", "assets", "auth",
  "bank-import", "bar", "blog", "book", "booking", "bookkeeping-export", "branches",
  "budgets", "callback", "cashbook", "cashflow", "channel-settings", "competitors",
  "connections", "consolidated-close", "contact", "cookies", "customers",
  "daily-close", "daily-report", "dashboard", "e", "events", "expenses", "expiry",
  "faktura", "favicon", "feedback", "forgot-password", "g", "gavekort",
  "getting-started", "health", "help", "home", "imports", "index", "insights",
  "inventory", "join", "khata", "loans", "login", "mail", "manifest", "mileage",
  "modules", "month-end", "more", "new", "null", "oauth", "onboarding", "outlets",
  "payment-imports", "personal", "portal", "pricing", "privacy", "profile", "r",
  "recently-deleted", "register", "reports", "reservations", "retention", "robots",
  "root", "s", "sales", "scan", "share-recipients", "sitemap", "staff", "staffing",
  "stand", "static", "status", "subscription", "support", "t", "tax", "team",
  "terminals", "terms", "undefined", "v2", "vat-report", "verify-email", "waste",
  "weather", "weekly-report", "wine-list", "workshop", "www",
];

const RESERVED = new Set(RESERVED_SLUGS);

function decode(seg) {
  try {
    return decodeURIComponent(seg);
  } catch {
    return null;
  }
}

/** The venue slug a booking-page path names, or null for any other path. */
export function bookingSlugOf(pathname) {
  const p = String(pathname || "").replace(/\/+$/, "");
  const r = /^\/r\/([^/]+)$/.exec(p);
  if (r) return decode(r[1]);
  const v = /^\/([^/]+)$/.exec(p);
  if (!v) return null;
  const slug = decode(v[1]);
  if (!slug || RESERVED.has(slug.toLowerCase())) return null;
  return slug;
}

export function isBookingPath(pathname) {
  return bookingSlugOf(pathname) != null;
}

/** True on a booking page in a plain browser — never in the native apps. */
export function isBookingPathNow() {
  try {
    if (import.meta.env?.VITE_APP_MODE === "scheduler") return false;
    if (typeof window === "undefined") return false;
    if (window.Capacitor?.isNativePlatform?.()) return false;
    return isBookingPath(window.location.pathname);
  } catch {
    return false;
  }
}
