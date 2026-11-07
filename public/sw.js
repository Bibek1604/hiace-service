// Sajilo Yatra service worker. It makes the app installable and gives a friendly offline page.
// It deliberately never caches API responses, staff areas or booking pages: those hold private data.
// Bump this whenever caching behaviour changes so installed clients discard old Next.js chunks.
const VERSION = 'sy-v2';
const STATIC = VERSION + '-static';
const PRECACHE = ['/offline.html', '/icons/icon-192.png', '/icons/icon-512.png'];
const PRIVATE = ['/api/', '/admin', '/operator', '/driver', '/staff', '/booking', '/track-booking'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(STATIC).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (PRIVATE.some((p) => url.pathname.startsWith(p))) return;

  // Deployment chunks can be replaced by an atomic Vercel deployment while an existing service
  // worker is still active. Revalidate first so an old chunk cannot be paired with new HTML.
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(STATIC).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || Response.error())),
    );
    return;
  }

  // Pages: always try the network so seats and prices are live; show the offline page only when it fails.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
  }
});
