/* Corpus — service worker. Serves photos at <site>/_blob/<id> from Supabase Storage as same-origin
   responses (so the app can crop and read them on a canvas) and keeps a copy on the device, and shows
   push reminders sent by the corpus-push function (supabase/functions/corpus-push).
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
  /* photos are only ever shown inside the app; opening a /_blob/ address as a page (or in a frame, script, ...) is refused */
  var dest = e.request.destination;
  if (e.request.mode === 'navigate' || (dest && dest !== 'image')) { e.respondWith(new Response('', { status: 404 })); return; }
  if (!PUBLIC || !/^[A-Za-z0-9_-]{6,80}$/.test(id)) { e.respondWith(new Response('', { status: 404 })); return; }
  e.respondWith(serve(id));
});

/* only plain raster pictures are handed out; anything else (SVG, HTML, ...) never reaches a page */
var SAFE_TYPE = /^image\/(jpeg|png|webp|gif)$/;
function safeResponse(b, type) {
  return new Response(b, { status: 200, headers: {
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'public, max-age=31536000, immutable' } });
}

async function serve(id) {
  var cache = await caches.open(CACHE), key = BLOB + id;
  var hit = await cache.match(key);
  if (hit) {
    var ht = String(hit.headers.get('Content-Type') || '').toLowerCase();
    if (SAFE_TYPE.test(ht)) return safeResponse(await hit.blob(), ht);
    try { await cache.delete(key); } catch (err) {}      // an old copy of something that is not a picture: drop it
  }
  var r;
  try { r = await fetch(PUBLIC + id, { mode: 'cors', credentials: 'omit', cache: 'no-store' }); }
  catch (err) { return new Response('', { status: 503 }); }
  if (!r.ok) return new Response('', { status: r.status === 400 ? 404 : r.status });
  var b = await r.blob();
  var type = String(b.type || r.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
  if (!SAFE_TYPE.test(type)) return new Response('', { status: 415 });
  var res = safeResponse(b, type);
  try { await cache.put(key, res.clone()); } catch (err) {}
  return res;
}

/* ---------- push reminders ---------- */
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  var scope = self.registration.scope;
  e.waitUntil(self.registration.showNotification(d.title || 'Corpus', {
    body: d.body || '', tag: d.tag || 'corpus', renotify: !!d.tag,
    icon: scope + 'icons/icon-192.png', badge: scope + 'icons/icon-192.png',
    data: { url: d.url || scope }
  }));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  var view = /[?&]v=cal\b/.test(url) ? 'calendar' : '';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.url.indexOf(self.registration.scope) === 0 && 'focus' in c) {
        if (view) c.postMessage({ corpus: 'open', view: view });
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
