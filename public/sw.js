/*
 * warehouse-floor-client service worker.
 *
 * Hand-written on purpose (no Workbox / vite-plugin-pwa; see README). It has
 * exactly one job: keep the APP SHELL loadable with no network. It is not a
 * data cache and never touches a command:
 *
 *   - non-GET requests ............ not intercepted (every command is a POST/PUT)
 *   - anything under /api/ ........ not intercepted (no API response is ever stored or replayed)
 *   - cross-origin requests ....... not intercepted
 *   - GET of a precached shell file  served from the cache, falling back to the network
 *   - navigations ................. network first, falling back to the cached index.html
 *
 * Commands made while offline are queued by the PAGE (outbox in localStorage)
 * and replayed with their original Idempotency-Key; the worker is not involved.
 *
 * The two build-time values below are stamped into dist/sw.js by
 * build/precacheManifest.ts after Vite has hashed the asset names.
 */
const PRECACHE = __PRECACHE__;
const CACHE_VERSION = "__CACHE_VERSION__";

const CACHE_PREFIX = "floor-shell-";
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;
const SHELL = new Set(PRECACHE);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      // cache:'reload' bypasses the HTTP cache so a new worker never precaches stale bytes.
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE_NAME).map((n) => caches.delete(n)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return; // commands are never handled here

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // API traffic is never cached or served from cache

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.open(CACHE_NAME).then((cache) => cache.match("/index.html")).then((hit) => hit || Response.error()),
      ),
    );
    return;
  }

  if (SHELL.has(url.pathname)) {
    event.respondWith(
      caches
        .open(CACHE_NAME)
        .then((cache) => cache.match(request))
        .then((hit) => hit || fetch(request)),
    );
  }
});
