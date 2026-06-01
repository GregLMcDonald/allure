/* =========================================================================
   Allure — service worker
   App-shell caching: precache on install, cache-first for the shell with a
   network fallback. Bump CACHE_VERSION to roll out an update; old caches are
   cleaned on activate.

   All paths are RELATIVE so the worker works under a GitHub Pages subpath.
   ========================================================================= */

const CACHE_VERSION = "allure-v1";

// The app shell. Google Fonts are cached opportunistically at runtime (below)
// so the app still installs even if the network is unavailable for fonts.
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

// Precache the shell on install.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // addAll fails the whole install if any request 404s, so add tolerantly.
      Promise.allSettled(SHELL.map((url) => cache.add(url)))
    )
  );
  self.skipWaiting();
});

// Clean up old caches on activate.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Fetch strategy:
//   - Navigations: network-first, fall back to cached index.html (offline).
//   - Same-origin shell assets: cache-first, fall back to network.
//   - Google Fonts (cross-origin): stale-while-revalidate so they work offline
//     after the first successful load.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Navigation requests -> network-first with offline fallback.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Keep the latest index.html warm in the cache.
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html").then((r) => r || caches.match("./")))
    );
    return;
  }

  // Google Fonts -> stale-while-revalidate.
  if (
    url.origin === "https://fonts.googleapis.com" ||
    url.origin === "https://fonts.gstatic.com"
  ) {
    event.respondWith(
      caches.open(CACHE_VERSION).then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req)
          .then((res) => {
            if (res && res.status === 200) cache.put(req, res.clone());
            return res;
          })
          .catch(() => null);
        return cached || network || fetch(req);
      })
    );
    return;
  }

  // Same-origin assets -> cache-first.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res && res.status === 200 && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
          }
          return res;
        });
      })
    );
  }
});
