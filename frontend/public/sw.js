const CACHE_NAME = "bonbox-v3";
const API_CACHE_NAME = "bonbox-api-v1";
const API_CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds
const STATIC_ASSETS = ["/manifest.json", "/icon-192.png", "/icon-512.png", "/favicon.svg"];

// --- API cache helpers ---

// Check if a URL is a cacheable dashboard endpoint
function isDashboardApi(url) {
  return url.includes("/api/dashboard/batch") || url.includes("/api/dashboard/");
}

// Auth endpoints must NEVER be cached (security)
function isAuthApi(url) {
  return url.includes("/api/auth/");
}

// Store a response with a timestamp so we can check TTL later
async function putWithTimestamp(cache, request, response) {
  // Store the actual response
  await cache.put(request, response.clone());
  // Store the timestamp in a parallel key
  const tsResponse = new Response(JSON.stringify({ timestamp: Date.now() }));
  await cache.put(request.url + "__ts", tsResponse);
}

// Check whether a cached entry has expired
async function isCacheExpired(cache, request) {
  const tsResponse = await cache.match(request.url + "__ts");
  if (!tsResponse) return true;
  try {
    const { timestamp } = await tsResponse.json();
    return Date.now() - timestamp > API_CACHE_TTL;
  } catch {
    return true;
  }
}

// Remove all expired entries from the API cache
async function cleanExpiredApiEntries() {
  const cache = await caches.open(API_CACHE_NAME);
  const keys = await cache.keys();
  const deletions = [];
  for (const key of keys) {
    // Skip timestamp meta-entries (they are cleaned with their parent)
    if (key.url.endsWith("__ts")) continue;
    const tsResponse = await cache.match(key.url + "__ts");
    if (!tsResponse) {
      // No timestamp found — stale orphan, delete both
      deletions.push(cache.delete(key));
      continue;
    }
    try {
      const { timestamp } = await tsResponse.json();
      if (Date.now() - timestamp > API_CACHE_TTL) {
        deletions.push(cache.delete(key));
        deletions.push(cache.delete(key.url + "__ts"));
      }
    } catch {
      deletions.push(cache.delete(key));
      deletions.push(cache.delete(key.url + "__ts"));
    }
  }
  return Promise.all(deletions);
}

// Install: cache static assets, skip waiting to activate immediately
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: delete old caches and clean expired API cache entries
self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      // Delete old static caches (but keep current + API cache)
      caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_NAME && k !== API_CACHE_NAME)
            .map((k) => caches.delete(k))
        )
      ),
      // Purge expired entries from the API cache
      cleanExpiredApiEntries(),
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

// Push: show native notification when backend sends a push event
self.addEventListener("push", (event) => {
  let data = { title: "BonBox", body: "You have a new notification", icon: "/icon-192.png" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon || "/icon-192.png",
      badge: "/icon-192.png",
      data: data.url || "/dashboard",
      vibrate: [100, 50, 100],
    })
  );
});

// Notification click: focus or open the app
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data || "/dashboard";
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && "focus" in client) return client.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});

// Fetch: network-first for everything, cache only for offline fallback
self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Skip non-GET requests
  if (request.method !== "GET") return;

  // Auth endpoints: NEVER cache (security — tokens, credentials, PII)
  if (isAuthApi(request.url)) return;

  // Dashboard API endpoints: stale-while-revalidate with 5-min TTL
  if (isDashboardApi(request.url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(API_CACHE_NAME);
        const cached = await cache.match(request);

        // Background revalidation: fetch from network and update cache
        const revalidate = fetch(request)
          .then(async (networkResponse) => {
            if (networkResponse.ok) {
              await putWithTimestamp(cache, request, networkResponse);
            }
            return networkResponse;
          })
          .catch(() => null); // swallow network errors silently

        // If we have a cached response and it's within TTL, return it immediately
        // and let the background fetch update the cache for next time
        if (cached) {
          const expired = await isCacheExpired(cache, request);
          if (!expired) {
            // Fresh cache — return it, revalidate in background
            revalidate; // fire-and-forget
            return cached;
          }
          // Expired cache — try network first, fall back to stale cache
          const networkResponse = await revalidate;
          return networkResponse && networkResponse.ok ? networkResponse : cached;
        }

        // No cache at all — must go to network (offline = failure)
        const networkResponse = await revalidate;
        if (networkResponse && networkResponse.ok) return networkResponse;
        // Network failed and no cache — return a proper error response
        return new Response(JSON.stringify({ error: "offline", message: "No cached data available" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      })()
    );
    return;
  }

  // All other API requests: network only (always fresh data)
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
