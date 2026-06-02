// Service worker: makes the app installable and usable offline by caching its
// own shell. The only network call is the public BTC-USD price (anonymous — it
// never includes your balance); those cross-origin requests aren't intercepted
// here, so they always go live to the network and the app still works offline.
const VERSION = 'btcbalance-v12';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // App shell — cache first, fall back to network, then to index for navigations.
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).catch(() => caches.match('./index.html')))
    );
  }
});
