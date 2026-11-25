/* Last Card service worker: the app opens offline (practice works without the internet),
   and your-turn alerts arrive while the app is closed. Pages and scripts are fetched fresh
   when online, so a deploy shows up straight away; the cache is only the offline fallback. */
const CACHE = 'lc-v1';
const SHELL = ['/', '/app.js', '/engine.js', '/socket.io/socket.io.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/socket.io/') && url.search) return; // live connection, never cached
  if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    // fonts: cache first, they never change
    e.respondWith(caches.open(CACHE).then((c) => c.match(req).then((hit) => hit || fetch(req).then((r) => { c.put(req, r.clone()); return r; }))));
    return;
  }
  if (url.origin !== location.origin) return;
  // the app itself: network first, cache as the offline fallback
  e.respondWith(fetch(req).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req.mode === 'navigate' ? '/' : req, copy)); }
    return r;
  }).catch(() => caches.match(req.mode === 'navigate' ? '/' : req).then((hit) => hit || caches.match('/'))));
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'Last Card', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Last Card', {
    body: d.body || '', tag: d.tag || 'lc', renotify: true, icon: '/icons/icon-192.png', badge: '/icons/badge-96.png', data: { url: d.url || '/' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) { c.navigate(url).catch(() => {}); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
