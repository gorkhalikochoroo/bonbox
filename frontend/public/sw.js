const CACHE_NAME = "bonbox-v5";
// 2026-05-25 — API cache key bumped (was bonbox-api-v1). The previous
// SW served /api/dashboard/* via stale-while-revalidate with a 5-min
// TTL, which meant after an optimistic-add on Sales/Expenses the very
// next dashboard read returned yesterday's KPI for up to 5 minutes.
// For a financial app where dashboard counters feed MOMS-aware mental
// models, that's not acceptable. This SW now treats ALL /api/* as
// NetworkOnly (no cache, ever). Bumping the cache key forces any
// previously-installed SW to nuke its stale dashboard cache on the
// next activation. See companion React-side fixes in 78e2d6e / ee80e93.
const API_CACHE_NAME = "bonbox-api-v2";
const STATIC_ASSETS = ["/manifest.json", "/icon-192.png", "/icon-512.png", "/favicon.svg", "/og-image.png"];

// --- API cache helpers ---

// Auth endpoints must NEVER be cached (security)
function isAuthApi(url) {
  return url.includes("/api/auth/");
}

// Purge any leftover entries from the previous API cache version.
// The old SW stored /api/dashboard/* responses with parallel "__ts"
// timestamp entries. We blow the whole cache away on activation so
// existing installed users don't read yesterday's KPI on next load.
async function purgeApiCache() {
  const cache = await caches.open(API_CACHE_NAME);
  const keys = await cache.keys();
  return Promise.all(keys.map((key) => cache.delete(key)));
}

// Install: cache static assets, skip waiting to activate immediately
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: delete old caches and purge the API cache entirely so any
// /api/dashboard/* entries left behind by the previous SW version
// (bonbox-api-v1) cannot be served.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      // Delete old static caches (but keep current + API cache name).
      // The previous API cache key (bonbox-api-v1) is NOT in this
      // allowlist, so it gets deleted here too.
      caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_NAME && k !== API_CACHE_NAME)
            .map((k) => caches.delete(k))
        )
      ),
      // Belt + braces: even if the cache name didn't change, blow away
      // anything left in the current API cache. Cheap on first activate
      // (the cache is empty) and protects against partial deploys.
      purgeApiCache(),
    ])
  );
  self.clients.claim();
});

// Message handler: allow page to force-clear caches
self.addEventListener("message", (event) => {
  if (event.data === "CLEAR_CACHE") {
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))));
  }
});

// Push: show native notification when backend sends a push event.
//
// Payload shape (Task #72 — see push_sender._compose_brief_payload):
//   { title: "BonBox · Daily brief",
//     body:  "<one-line summary>",
//     tag:   "bonbox-daily-brief",     // dedupes same-brief duplicates
//     data:  { url: "/?brief=open" } } // landing path on tap
//
// Known tags in use:
//   bonbox-daily-brief                   — 8am Brief (owner)
//   bonbox-schedule-<owner_id>-<week>    — Staff v2 schedule_published
//                                          (Task #242 — staff portal push)
//
// Privacy invariant: payloads NEVER carry amounts / customer names —
// the body is the brief headline only. We trust the server composer.
self.addEventListener("push", (event) => {
  let data = { title: "BonBox", body: "You have a new notification" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    // Malformed payload — fall back to the generic defaults. Better to
    // show "BonBox: You have a new notification" than to crash + log
    // an error the user can't see.
  }
  // data.data is the OBJECT we forward to the click handler. Old code
  // stored a bare URL string here; we keep back-compat with that path
  // in notificationclick below.
  const clickData = data.data || { url: data.url || "/" };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon || "/icon-192.png",
      badge: "/icon-192.png",
      data: clickData,
      tag: data.tag || undefined,            // dedupe same-brief pushes
      // renotify only if a tag was passed — without it the spec says
      // showNotification ignores the field.
      renotify: data.tag ? true : false,
      vibrate: [100, 50, 100],
    })
  );
});

// Notification click: focus or open the app
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Back-compat: older payloads stuffed the URL directly in data as a
  // string. New payloads use {url: "/path"}. Accept both.
  const raw = event.notification.data;
  let url = "/";
  if (raw && typeof raw === "object" && raw.url) url = raw.url;
  else if (typeof raw === "string" && raw) url = raw;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(
      (clients) => {
        // Try to focus an existing window first — owners typically
        // already have BonBox open in another tab.
        for (const client of clients) {
          if (
            client.url.includes(self.location.origin) &&
            "focus" in client
          ) {
            // Navigate the existing tab to the target URL (matters for
            // /?brief=open which auto-opens the brief modal).
            try {
              if ("navigate" in client) client.navigate(url);
            } catch {
              // Some browsers refuse navigate() on cross-origin URLs;
              // fall through to focus + hope the URL is already right.
            }
            return client.focus();
          }
        }
        return self.clients.openWindow(url);
      },
    ),
  );
});

// Fetch: network-first for everything, cache only for offline fallback
self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Skip non-GET requests
  if (request.method !== "GET") return;

  // Auth endpoints: NEVER cache (security — tokens, credentials, PII)
  if (isAuthApi(request.url)) return;

  // ALL /api/* GETs: NetworkOnly. BonBox is a financial app — every
  // dashboard / sales / expenses / faktura / inventory / billing /
  // bank-connect / dashboard-batch response is mutable, and serving a
  // stale value (even by a few minutes) produces wrong MOMS totals,
  // wrong daily summaries, and wrong accountant-bound artifacts.
  //
  // We deliberately do NOT add a stale-while-revalidate path for any
  // /api/* endpoint here. If a future immutable endpoint shows up
  // (e.g. /api/config/features, /api/app-version), allowlist it
  // explicitly above this guard — don't widen the cache by default.
  //
  // Companion React-side fixes for the same freshness invariant:
  //   - 78e2d6e  optimistic-add + focus-refetch on SalesPage/ExpensesPage
  //   - ee80e93  trial-Starter+ nudge flicker on cold load
  if (request.url.includes("/api/")) return;

  // HTML navigation: network-first, cache fallback
  if (request.mode === "navigate" || request.url.endsWith(".html")) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // JS/CSS bundles: network-first, NO stale cache fallback
  // Hashed filenames change on deploy — serving old cache causes crashes
  if (request.url.includes("/assets/")) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          // Only return cached version if URL hash matches (same deploy)
          return caches.match(request);
        })
    );
    return;
  }

  // Static assets (icons, manifest): cache first, update in background
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchPromise = fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached);

      return cached || fetchPromise;
    })
  );
});
