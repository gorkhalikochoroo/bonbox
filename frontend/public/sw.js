const CACHE_NAME = "bonbox-v3";
const STATIC_ASSETS = ["/manifest.json", "/icon-192.png", "/icon-512.png", "/favicon.svg"];

// Install: cache static assets, skip waiting to activate immediately
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: delete ALL old caches aggressively
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Message handler: allow page to force-clear caches
self.addEventListener("message", (event) => {
  if (event.data === "CLEAR_CACHE") {
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))));
  }
});

// Fetch: network-first for everything, cache only for offline fallback
self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Skip non-GET requests
  if (request.method !== "GET") return;

  // API requests: network only (always fresh data)
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
