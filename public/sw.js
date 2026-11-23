const CACHE = 'clouddisk-shell-v55';

const CORE = [
  '/assets/app.css',
  '/assets/app.js',
  '/assets/login.css',
  '/assets/login.js',
  '/assets/share.css',
  '/assets/share.js',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png',
  '/assets/icons/icon-180.png',
  '/assets/icons/icon-maskable-512.png',
  '/assets/icons/logo-mark-white.png',
  '/assets/icons/logo-mark-brown.png',
  '/favicon.svg',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.allSettled(CORE.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 页面发现新版本时可主动通知跳过等待，立即接管
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const cacheable = url.pathname.startsWith('/assets/') || url.pathname === '/manifest.webmanifest';
  if (!cacheable) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request);
        if (response && response.ok) cache.put(request, response.clone());
        return response;
      } catch {
        const cached = await cache.match(request);
        return cached || Response.error();
      }
    })()
  );
});