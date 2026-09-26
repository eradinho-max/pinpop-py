const CACHE_NAME = 'pinpop-admin-v1';
const APP_SHELL = [
  '/admin',
  '/style.css?v=2.3.8',
  '/tailwind-built.css?v=2.2.2',
  '/vendor/icons.js?v=2.2.2',
  '/app.js?v=2.3.8',
  '/images/brand/pinpop-logo-web.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache live API/admin data.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request));
    return;
  }

  // Admin navigation: network first so a new deployment is picked up quickly.
  if (request.mode === 'navigate' && url.pathname.startsWith('/admin')) {
    event.respondWith(
      fetch(request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put('/admin', clone));
          return response;
        })
        .catch(() => caches.match('/admin'))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request))
  );
});
