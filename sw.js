// Pitchside service worker: caches the app shell so it opens offline.
// Bump CACHE when you change any file, so installed copies pick up the update.
const CACHE = 'pitchside-202611052111';
const KEEP = 'pitchside-keep'; // holds the ball model and the ONNX files; survives updates
const SHELL = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/analysis.js', 'js/db.js', 'js/export.js', 'js/ball.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('pitchside-') && k !== CACHE && k !== KEEP).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (new URL(req.url).pathname.includes('/api/')) return;   // server calls (e.g. the Gemini proxy) are never cached
  // big fixed library files: cache first, kept across updates
  if (new URL(req.url).pathname.includes('/js/vendor/')) {
    e.respondWith(caches.open(KEEP).then(c => c.match(req).then(hit => hit || fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }))));
    return;
  }
  // network first so updates arrive, falling back to the cache when offline
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('index.html')))
  );
});
