const CACHE_NAME = 'mystyle-v48';
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/app30.js',
  './js/db30.js',
  './js/models.js',
  './js/color-engine.js',
  './js/outfit-generator.js',
  './js/cloud-ai.js',
  './js/utils.js',
  './manifest.json',
  'https://cdn.jsdelivr.net/npm/pouchdb@8.0.1/dist/pouchdb.min.js'
];

self.addEventListener('install', e => {
  // Skip waiting — take over immediately
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(ASSETS).catch(() => {}))
  );
});

self.addEventListener('activate', e => {
  // Delete ALL old caches immediately
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first: always try fresh, cache as fallback for offline
self.addEventListener('fetch', e => {
  e.respondWith(
    fetch(e.request)
      .then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(e.request))
  );
});
