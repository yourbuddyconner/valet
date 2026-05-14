// TODO: Integrate ACP (Agent Client Protocol) to enable connecting Valet to local
// coding agents and vice versa. This PWA is the foundation for a native-feeling
// desktop experience that can bridge cloud-hosted agent sessions with local dev tools.

// Minimal service worker for PWA installability.
// This does NOT provide offline support or caching — it simply satisfies
// Chrome's PWA install criteria (a registered service worker with a fetch handler).

self.addEventListener('install', (event) => {
  // Activate immediately — no waiting for existing clients to close
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Claim all open clients so the SW is controlling pages right away
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Only intercept same-origin requests; let cross-origin fall through to browser default
  if (event.request.url.startsWith(self.location.origin)) {
    event.respondWith(fetch(event.request));
  }
});
