/* Corpus — service worker. Serves photos at <site>/_blob/<id> from Supabase Storage as same-origin
   responses (so the app can crop and read them on a canvas) and keeps a copy on the device.
   It touches nothing else: pages, scripts and data always come from the network. */
var PUBLIC = new URL(self.location.href).searchParams.get('b') || '';
var CACHE = 'corpus-blobs-v1';
var BLOB = new URL(self.registration.scope).pathname + '_blob/';

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('message', function (e) { if (e.data === 'claim') e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var u = new URL(e.request.url);
  if (u.origin !== self.location.origin || u.pathname.indexOf(BLOB) !== 0) return;
  var id = u.pathname.slice(BLOB.length);
  if (!PUBLIC || !/^[A-Za-z0-9_-]{6,80}$/.test(id)) { e.respondWith(new Response('', { status: 404 })); return; }
  e.respondWith(serve(id));
});

async function serve(id) {
  var cache = await caches.open(CACHE), key = BLOB + id;
  var hit = await cache.match(key);
  if (hit) return hit;
  var r;
  try { r = await fetch(PUBLIC + id, { mode: 'cors', credentials: 'omit', cache: 'no-store' }); }
  catch (err) { return new Response('', { status: 503 }); }
  if (!r.ok) return new Response('', { status: r.status === 400 ? 404 : r.status });
  var b = await r.blob();
  var res = new Response(b, { status: 200, headers: {
    'Content-Type': b.type || r.headers.get('content-type') || 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable' } });
  try { await cache.put(key, res.clone()); } catch (err) {}
  return res;
}
