// H.A.I.L. Sentinel service worker: offline app-shell cache. Bump VERSION on every deploy.
const VERSION = 'sentinel-v1.0.0';
const SHELL = [
  './', 'index.html', 'manifest.json', 'css/app.css',
  'js/app.js', 'js/store.js', 'js/codec.js', 'js/rtc.js', 'js/signal.js', 'js/qr.js',
  'vendor/peerjs-1.5.5.min.js', 'vendor/jsQR-1.4.0.js', 'vendor/qrcode-generator-2.0.4.js',
  'fonts/Cinzel-Regular.ttf', 'fonts/Cinzel-Bold.ttf', 'fonts/Rajdhani-SemiBold.ttf', 'fonts/Rajdhani-Bold.ttf',
  'fonts/Montserrat-Regular.ttf', 'fonts/Montserrat-SemiBold.ttf', 'fonts/Montserrat-Bold.ttf',
  'img/banner.jpg', 'img/crest-256.png',
  'icons/icon-180.png', 'icons/icon-167.png', 'icons/icon-152.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/favicon-64.png',
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // broker websocket / STUN are never cached
  if (req.mode === 'navigate') {
    // deep links (?action=live, ?action=pair, ?role=station) all resolve to the cached shell
    e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put('index.html', copy)); return r; })
      .catch(() => caches.match('index.html')));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => {
    const net = fetch(req).then(r => { if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});
