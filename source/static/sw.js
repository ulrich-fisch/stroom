// Stroom-diensskakel: laat die toep installeer en wys 'n vriendelike bladsy as jy aflyn is.
// Dit stoor NOOIT ingeteken bladsye, API-antwoorde of video's nie (net die toep se vaste lêers).
const CACHE = 'stroom-v1';
const SHELL = ['/offline.html', '/stroom.css', '/app.js', '/icon-192.png', '/favicon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const STATIC = /\.(?:css|js|png|webmanifest)$/;
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/') || req.headers.has('range')) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }
  if (STATIC.test(url.pathname)) {   // eers die netwerk (altyd nuutste weergawe), kas as jy aflyn is
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req)));
  }
});
