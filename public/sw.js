// Self-destructing service worker.
//
// The previous caching worker left wallet in-app webviews (Zerion etc.) on stale app
// shells with out-of-sync chunk caches, which caused "Failed to fetch dynamically
// imported module" crashes after every deploy. HTTP caching (immutable /assets +
// no-cache HTML via _headers) covers us fine without a service worker, so we remove it.
//
// sw.js is served with Cache-Control: no-cache, so every client that still has the old
// worker re-fetches THIS file on its next navigation, installs it, and then it wipes all
// caches, unregisters itself, and reloads open pages into a clean, worker-free app.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (e) { /* ignore */ }
    try {
      await self.registration.unregister();
    } catch (e) { /* ignore */ }
    try {
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach((client) => {
        try { client.navigate(client.url); } catch (e) { /* ignore */ }
      });
    } catch (e) { /* ignore */ }
  })());
});

// No fetch handler — with no interception, the browser/webview loads everything straight
// from the network (HTML) or its own HTTP cache (immutable assets), never a stale shell.
